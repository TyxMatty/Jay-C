# Host your own Jay-C server

Calls go through a small server that **one** person in the group runs on their PC: the host. It takes about 10 minutes, once. Everyone else only connects (the **Connecting** tab).

- Your PC must be on, with the server running, for anyone to call.
- Everyone's video goes through your PC, so your upload speed matters (see step 4).

## 1. Install the server

Pick one way. **Node.js is the simplest**, and it's all you need with Radmin VPN or ZeroTier.

### Option A: Node.js (recommended)

1. Install **Node.js** (the LTS version, 22 or newer) from `nodejs.org`.
2. Get the Jay-C source as a ZIP: on its GitHub page (`github.com/TyxMatty/Jay-C`), click **Code › Download ZIP**. If the page doesn't open for you, ask whoever sent you Jay-C for the ZIP. Extract it to a **short** folder, for example `C:\jay-c`. Deep folders (like Downloads inside OneDrive) break the extraction, because some file paths get too long for Windows.
3. Open a terminal in the folder that has `package.json` and run, once:

```
npm install -w signaling-server
```

### Option B: Docker

Install Docker Desktop from `docker.com` and open it once. Then save the file `docker-compose.yml` from the Jay-C releases page in an empty folder, for example `C:\jay-c`.

![A PC running the Jay-C server inside Docker](/assets/setup/step1_docker.svg)

## 2. Start the server

**Node.js:** in the same folder, run the command below and **leave the terminal open**. Closing it stops the server, so run it again whenever you want to call.

```
npm run server
```

When it says `listening on 0.0.0.0:3000`, it's ready. If Windows asks whether Node.js may use the network, allow it. To update later, download the ZIP again and repeat step 1.

**Docker:** open a terminal in the folder with `docker-compose.yml` and run:

```
docker compose up -d
```

The first time, Docker downloads the server (about 400 MB). From then on it starts by itself with Docker. To update it later, run `docker compose pull` and the same command again.

![The server starting in a terminal](/assets/setup/step2_compose.svg)

## 3. Open the ports

The server uses **two ports**: `3000` (TCP) for signaling and `40000` (UDP and TCP) for audio and video. If the firewall blocks the second one, people connect but can't see or hear each other.

On Windows, open PowerShell **as administrator** on the server PC and run:

```
New-NetFirewallRule -DisplayName "Jay-C" -Direction Inbound -Protocol TCP -LocalPort 3000,40000 -Action Allow
New-NetFirewallRule -DisplayName "Jay-C media" -Direction Inbound -Protocol UDP -LocalPort 40000 -Action Allow
```

![Ports 3000 and 40000 open in the firewall](/assets/setup/step3_firewall.svg)

## 4. Find the server's address

- **Same network (home, LAN party):** on the server PC, run `ipconfig` and use the **IPv4 Address**, for example `192.168.1.50`.
- **Over the internet:** everyone joins the same virtual network with ZeroTier or Radmin VPN, and you use the server PC's address on that network. Avoid opening the ports on your router.

**Mind the upload.** All video goes through the server PC, which sends a copy to each viewer. A screen share needs about **5 Mbps of upload per viewer at 1080p30** and 7.5 Mbps at 1080p60, so 15 viewers of a 1080p60 share need about 110 Mbps. On a LAN that's easy; over the internet, the host's upload speed is the limit. Lower the share quality if people see stutters.

![Friends connecting to the server PC](/assets/setup/step4_address.svg)

## 5. Connect, and invite your friends

On this PC, open **Settings › Server** in Jay-C, enter `localhost:3000`, press **Test** and then **Add**. When it says "Connected", pick a room name.

Then send your friends two things: the server address from step 4 (for example `192.168.1.50:3000`) and the room name. They follow the **Connecting** tab.

## 6. The admin key (optional)

Jay-C 0.5 and newer list the server's rooms and text channels next to it. Whoever has the server's **admin key** manages them from the app. Without a key, the server works as before, and nobody can change its rooms or channels.

**On the server,** pick a long secret only you know (like a password, at least 20 characters) and start the server with it:

- **Node.js:** in PowerShell, `$env:ADMIN_KEY="a-long-secret"; npm run server`. Use the same command every time you start it: without the key, nobody can manage the server.
- **Docker:** in `docker-compose.yml`, remove the `#` before `ADMIN_KEY`, put your secret there and run `docker compose up -d` again. On Linux, let the server write its data once: `mkdir -p data && sudo chown 1000:1000 data`.

To show a name instead of the address, also set `SERVER_NAME` (e.g. `$env:SERVER_NAME="Game nights"`, or in `docker-compose.yml`).

[[admin-key-field]]

**In the app,** register the key once on each computer that will manage the server:

1. Click the server in the left column. A **gear** shows next to its name, above the channels (only on servers started with a key).
2. Click the gear, type the key in **Admin key** and press **Unlock**.
3. Jay-C remembers the key for this server and unlocks by itself next time.

- **Wrong key:** "That isn't this server's admin key." After 5 wrong tries, the server waits 10 s between tries.
- **Changing the key:** restart the server with the new one. Computers with the old key ask for it again.
- **Another admin:** give them the key, through a private channel.
- **On a shared computer:** **Forget the key**, at the bottom of the server settings, takes it off this computer.

The server never writes the key to its log or its files.

## 7. Rooms everyone sees

With the key registered, open the gear. Under **Call rooms**:

- **New room:** a name (letters, numbers, `-` and `_`), and **Save**. It shows in the list for everyone, at once.
- **Password** (optional): the room shows a lock, and people type it to join.
- **Hidden** (only with a password): the room stays out of the list. People join by typing its name in **Direct call**.
- **Edit** a room to rename it or change its password; **Delete** asks once more before deleting. A room with people in it can't be renamed.

A room joined by any other name, from **Direct call**, works as before, but stays out of the list.

## 8. Text channels

Text channels are chats that stay on the server, for everyone on it, also outside calls. The server keeps the last 500 messages of each.

With the key registered, open the gear. Under **Text channels**:

1. **New channel:** type the **Channel name** (letters, numbers, `-` and `_`, e.g. `general` or `game-plans`) and press **Save**. It shows under **Text channels** for everyone on the server, at once.
2. **Rename:** type the new name and **Save**. The messages stay.
3. **Delete:** press it twice (the second time it asks "Delete with its messages?"). The channel's messages and files are deleted from the server, and that can't be undone.

Press **Done** to close. Everyone can read and write in the channels; a dot marks the ones with new messages. The server keeps them in its `data` folder (`channels.json` and `history`).

## 9. Pictures, GIFs and videos in the chats

Jay-C 0.5 and newer can send images (PNG, JPEG, WebP), GIFs and videos (MP4, WebM) in the call's chat and in text channels. It's on by default, and the files stay on your server: no outside service sees who sends or watches them.

- **Where they go:** the `data/media` folder. A file is deleted with its message: when it falls out of a channel's last 500 messages, when the channel is deleted, or when the call empties (the call's chat keeps no history).
- **Limits:** 8 MB per image and 50 MB per video, and 2 GB for all of them together. Change them with `MAX_IMAGE_MB`, `MAX_VIDEO_MB` and `MEDIA_DISK_MB` (e.g. `$env:MEDIA_DISK_MB="10000"`, or in `docker-compose.yml`). Past the total, new files are refused until old messages leave.
- **Bandwidth:** everyone who sees a file downloads it from your server. Videos only download when someone plays them.
- **To turn it off:** `MEDIA=off`.

Only people in that call, or on your server, can see its files. Before a photo or video goes up, the app takes out where it was taken (the GPS in its metadata).
