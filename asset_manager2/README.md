# CENS Assets Tracker

Phone-first PWA for laboratory asset tracking. The UI supports English and Korean. It is a static web app designed for Firebase Hosting and starts with local browser storage.

## Service Ports

- Frontend: `5040`
- Backend: `8040` reserved for future API work
- Override local defaults in `.env.local` using `.env.example`.

## Run Locally

Camera QR scanning requires HTTPS or localhost. For phone testing on the same network, use an HTTPS tunnel or a local HTTPS server.

Recommended start:

```sh
./start.sh
```

Check status or stop:

```sh
./status.sh
./stop.sh
```

Basic desktop test without the helper:

```sh
python3 -m http.server 5040 -d public
```

Open `http://localhost:5040`.

Phone camera test on the same network:

```sh
FRONTEND_HOST=0.0.0.0 FRONTEND_PORT=5040 python3 dev-server.py --https
```

Open `https://YOUR_COMPUTER_LAN_IP:5040` on the phone and accept the local development certificate warning. The app itself stays static; this helper only serves files for local testing.

## Data And Configuration

- Runtime app data is stored in browser `localStorage` with `cens.*` keys.
- The home screen is a phone-first work console with locked name/location inputs, asset search, QR scan, new asset entry, total list, and My List inside one list space.
- Initial asset data is generated from the Google Sheets `CENS Equipment` tab into `public/seed-assets.js`.
- Sheet fields for unit price, manufacturer/provider, acquisition date, and account holder are stored as separate asset fields, not appended to `description`.
- `.env.local` is machine-specific and ignored by Git.
- `GOOGLE_APPS_SCRIPT_URL` is reserved for future Google Sheets sync configuration. The current app also has an in-app backend URL setting.

## Firebase Hosting

```sh
firebase deploy --only hosting
```

No Firebase credentials are stored in this app.

## Data Tabs for Future Google Sheets Backend

Create three tabs:

- `Assets`
- `Records`
- `PresetLists`

The app includes a backend URL setting for a Google Apps Script Web App URL. The current `BackendGateway` keeps local storage as the active data source and exposes clean extension points for Google Sheets sync, Google Drive photo upload, PDF generation, and Firebase Auth.
