#!/usr/bin/env python3
"""chat_relay — Claude Code answering `@claude` in the portal chat, from this Mac.

Watches the portal chat rooms through the portal's MCP (chat_rooms / chat_read),
and for each new line that says `@claude` runs Claude Code headless
(`claude -p`) and posts the answer back into that message's thread
(chat_send, shown under the token's name, not as the person). One Claude
conversation per room, resumed each time (`--resume`), so it remembers the room.

    # one-time: a portal MCP token that may write (Settings → MCP), saved here:
    #   ~/.config/lilak/chat-relay-token      (or LILAK_CHAT_TOKEN=…)
    python3 scripts/chat_relay.py            # watch, every 10 s
    python3 scripts/chat_relay.py --once     # one pass, then exit
    python3 scripts/chat_relay.py --selftest

Environment: PORTAL_URL (http://localhost:8025), LILAK_CHAT_TOKEN, CHAT_RELAY_EVERY
(seconds), CHAT_RELAY_CLAUDE_ARGS (extra `claude` flags, e.g. --allowedTools …: by
default the headless run may not use tools that need approval), CHAT_RELAY_CWD
(where `claude` runs; the home folder).

Only lines written by a person trigger it (not its own, not another program's),
and only lines newer than when it started: it does not answer the history.
"""
import json
import os
import re
import shlex
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

HOME = Path.home() / ".config" / "lilak"
STATE = HOME / "chat-relay.json"
TOKEN_FILE = HOME / "chat-relay-token"
URL = os.environ.get("PORTAL_URL", "http://localhost:8025").rstrip("/")
EVERY = float(os.environ.get("CHAT_RELAY_EVERY", "10"))
CALLS = re.compile(r"(?<![\w@])@claude\b", re.I)


def wants_claude(line: dict) -> bool:
    """A person's line that calls @claude (a program's lines never do, its own included)."""
    return not line.get("via") and bool(CALLS.search(line.get("text") or ""))


def prompt_for(room: str, line: dict, context: list) -> str:
    talk = "\n".join(f"{m['who']}{' (' + m['via'] + ')' if m.get('via') else ''}: {m['text']}" for m in context[-12:])
    ask = CALLS.sub("", line["text"]).strip()
    return (f"You are Claude, answering in the LILAK portal's chat room '{room}'. Recent lines:\n{talk}\n\n"
            f"{line['who']} asks you: {ask}\n\n"
            "Answer as a short chat reply, in the language they used. Plain text, no headings.")


def mcp(token: str, name: str, **args) -> dict:
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": "tools/call",
                       "params": {"name": name, "arguments": args}}).encode()
    req = urllib.request.Request(f"{URL}/mcp", data=body, method="POST",
                                 headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=60) as r:
        res = json.load(r)["result"]
    text = res["content"][0]["text"]
    if res.get("isError"):
        raise RuntimeError(f"{name}: {text}")
    return json.loads(text)


def ask_claude(prompt: str, session: str | None) -> tuple[str, str | None]:
    cmd = ["claude", "-p", prompt, "--output-format", "json"]
    if session:
        cmd += ["--resume", session]
    cmd += shlex.split(os.environ.get("CHAT_RELAY_CLAUDE_ARGS", ""))
    out = subprocess.run(cmd, capture_output=True, text=True, timeout=600,
                         cwd=os.environ.get("CHAT_RELAY_CWD", str(Path.home())))
    if out.returncode != 0:
        raise RuntimeError((out.stderr or out.stdout).strip()[-500:])
    data = json.loads(out.stdout)
    return (data.get("result") or "").strip(), data.get("session_id")


def load_state() -> dict:
    try:
        return json.loads(STATE.read_text())
    except (OSError, ValueError):
        return {"last": {}, "sessions": {}}


def save_state(s: dict) -> None:
    HOME.mkdir(parents=True, exist_ok=True)
    STATE.write_text(json.dumps(s, indent=1))


def one_pass(token: str, state: dict) -> int:
    answered = 0
    for room in mcp(token, "chat_rooms")["rooms"]:
        if room == "system":          # the account's own room already goes to the platform agent
            continue
        after = state["last"].get(room)
        got = mcp(token, "chat_read", room=room, after=after or 0, limit=200)["messages"]
        if after is None:            # first sight of this room: start from now, not from its history
            state["last"][room] = max([m["id"] for m in got], default=0)
            continue
        for line in got:
            state["last"][room] = max(state["last"][room], line["id"])
            if not wants_claude(line):
                continue
            try:
                answer, sid = ask_claude(prompt_for(room, line, got), state["sessions"].get(room))
                if sid:
                    state["sessions"][room] = sid
            except Exception as e:  # say so in the chat rather than going quiet
                answer = f"(Claude를 부르지 못했습니다: {e})"
            mcp(token, "chat_send", room=room, text=answer or "(빈 답)", reply_to=line["id"])
            answered += 1
        save_state(state)
    return answered


def selftest() -> None:
    assert wants_claude({"text": "@claude 요약해줘", "via": ""})
    assert wants_claude({"text": "이거 @Claude, 봐줘"})
    assert not wants_claude({"text": "@claude hi", "via": "claude"})        # its own answer
    assert not wants_claude({"text": "mail me@claude.ai"})                  # an address is not a call
    assert not wants_claude({"text": "@claudette"})
    p = prompt_for("portal", {"who": "kim", "text": "@claude 런 42는?"}, [{"who": "lee", "text": "런 42 끝", "via": ""}])
    assert "kim asks you: 런 42는?" in p and "lee: 런 42 끝" in p
    print("selftest ok")


def main() -> None:
    if "--selftest" in sys.argv:
        return selftest()
    token = os.environ.get("LILAK_CHAT_TOKEN") or (TOKEN_FILE.read_text().strip() if TOKEN_FILE.exists() else "")
    if not token:
        sys.exit(f"no token: put a portal MCP token (write) in {TOKEN_FILE} or LILAK_CHAT_TOKEN")
    state = load_state()
    while True:
        try:
            n = one_pass(token, state)
            if n:
                print(f"answered {n}", flush=True)
        except Exception as e:  # the portal restarting is not a reason to stop
            print(f"pass failed: {e}", file=sys.stderr, flush=True)
        if "--once" in sys.argv:
            return
        time.sleep(EVERY)


if __name__ == "__main__":
    main()
