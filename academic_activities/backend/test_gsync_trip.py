"""Google shows the whole trip, and its days come back into the trip.
Run: python3 backend/test_gsync_trip.py"""
from gsync import act_patch, canon_act

ev = {"name": "APPC15", "start": "2026-08-22", "end": "2026-08-25", "startTime": "09:00", "endTime": "18:00"}

# No trip, or a trip inside the event: the event as it is.
assert canon_act(ev, {})["start"] == "2026-08-22" and canon_act(ev, {})["st"] == "09:00"
same = {**ev, "tripStart": "2026-08-22", "tripEnd": "2026-08-25"}
assert canon_act(same, {})["st"] == "09:00"

# A longer trip: its days, all day.
trip = {**ev, "tripStart": "2026-08-21", "tripEnd": "2026-08-26"}
c = canon_act(trip, {})
assert (c["start"], c["end"], c["st"], c["et"]) == ("2026-08-21", "2026-08-26", "", "")

# Only one end set still stretches it.
assert canon_act({**ev, "tripEnd": "2026-08-27"}, {})["end"] == "2026-08-27"

# Online or absent: no trip.
assert canon_act({**trip, "online": True}, {})["start"] == "2026-08-22"
assert canon_act({**trip, "role": "absence"}, {})["start"] == "2026-08-22"

# Days moved on Google move the trip; the event keeps its days and hours.
r = act_patch(trip, {**c, "start": "2026-08-20"}, "now")
assert (r["tripStart"], r["tripEnd"], r["start"], r["startTime"]) == ("2026-08-20", "2026-08-26", "2026-08-22", "09:00")

# Without a trip, Google's days are the event's.
r = act_patch(ev, {**canon_act(ev, {}), "start": "2026-08-23"}, "now")
assert r["start"] == "2026-08-23" and "tripStart" not in r

print("ok")
