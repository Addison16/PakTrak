# Installing on Unraid

PakTrak runs on Unraid with the same scripts as any other Docker host. Unraid has no Git, so you unpack PakTrak from a download instead of cloning it, and `sh scripts/update.sh` downloads each new release the same way. Everything below can be done from the Unraid web interface, including on a phone.

The published images are for x86-64 (amd64) servers.

## 1. Add Docker Compose

PakTrak is a set of containers started together by Docker Compose, which Unraid doesn't include. In the **Apps** tab, search for **Docker Compose Manager** and install it. This adds the `docker compose` command.

## 2. Download PakTrak

Open the terminal with the **>_** button at the top of the Unraid web interface, then run:

```sh
mkdir -p /mnt/user/appdata/paktrak
cd /mnt/user/appdata/paktrak
curl -fsSL https://github.com/Addison16/PakTrak/archive/refs/heads/main.tar.gz | tar -xz --strip-components=1
```

This only fetches the setup scripts. The next step installs the latest published release.

## 3. Set up and start

Pick the address you will open PakTrak at. To use it on your home network over plain HTTP, use your server's IP address and port 8095 (replace `192.168.1.50` with your server's address):

```sh
sh scripts/setup.sh --url http://192.168.1.50:8095 --bind 0.0.0.0 --allow-http
sh scripts/update.sh
```

`--bind 0.0.0.0` lets other devices on your network reach port 8095. `--allow-http` is needed for a plain HTTP address that isn't `localhost`.

The first start downloads the images and prepares the database and sign-in service, which takes a few minutes. When the terminal prints **PakTrak is running**, open `http://192.168.1.50:8095` and choose **Create administrator account**.

Over plain HTTP, browsers turn off the live in-app camera. **Phone camera** and **Library** uploads still work. For the in-app camera, use HTTPS as described below.

## Using HTTPS

If you already run a reverse proxy on Unraid (for example a proxy manager container) with a hostname and certificate, set it up first and point it at `http://YOUR-SERVER-IP:8095`. Allow uploads of at least 100 MB. Then use that address during setup:

```sh
sh scripts/setup.sh --url https://cards.example.net --bind 0.0.0.0
sh scripts/update.sh
```

To move an existing installation from the HTTP address to HTTPS later, edit `APP_URL` in `/mnt/user/appdata/paktrak/.env` and run `sh scripts/start.sh`. Accounts and collections are kept. See [changing the hostname](OPERATIONS.md#https-and-access-from-a-phone).

## Updating

Back up, then update to the latest release:

```sh
cd /mnt/user/appdata/paktrak
sh scripts/backup.sh /mnt/user/backups/paktrak-$(date +%Y%m%d)
sh scripts/update.sh
```

The update downloads the release, keeps your `.env` and data, pulls the matching images and restarts PakTrak. To restart without updating, run `sh scripts/start.sh`.

## Where your data lives

`/mnt/user/appdata/paktrak` holds the scripts, the Compose file and `.env`, which contains your private passwords. Your collection, photos and accounts live in Docker volumes inside Unraid's Docker storage (**Settings → Docker**). Deleting or recreating that storage deletes them, so take a backup first. Backups made with `sh scripts/backup.sh` include the volumes, `.env` and the installed images; keep a copy off the server. [Backups and restores](OPERATIONS.md#upgrades-and-backups) covers the details.

## Starting with the server

The containers restart automatically whenever Docker starts, so PakTrak comes back after a reboot or array restart. They appear in the **Docker** tab. Use the scripts above rather than the per-container buttons, so the services start in the right order.
