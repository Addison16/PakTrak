# Installing on Unraid

The simplest way to run PakTrak on Unraid is the single PakTrak container. It holds the database, sign-in service, photo storage, app and web server, and appears as one container on the **Docker** page, where Unraid updates it like any other. Everything below can be done from the Unraid web interface, including on a phone.

The published images are for x86-64 (amd64) servers. If you would rather run the separate containers with Docker Compose, see [Docker Compose on Unraid](#docker-compose-on-unraid) at the end.

## Add the container

1. Open the terminal with the **>_** button at the top of the Unraid web interface and run this once to add the PakTrak template:

   ```sh
   curl -fsSL -o /boot/config/plugins/dockerMan/templates-user/my-PakTrak.xml https://raw.githubusercontent.com/Addison16/PakTrak/main/infra/unraid/paktrak.xml
   ```

2. On the **Docker** page, choose **Add Container**, then pick **PakTrak** from the **Template** list.
3. Set **App address** to the address you will open PakTrak at, including the port. On your home network that is your server's IP address and port 8095, for example `http://192.168.1.50:8095`.
4. Leave **Web port** at 8095 and **Data** at `/mnt/user/appdata/paktrak` unless you need something else, then choose **Apply**.

The first start takes a few minutes while the database and sign-in service are prepared. The container log shows **PakTrak is running** when it is ready. Open the address and choose **Create administrator account**.

Over plain HTTP, browsers turn off the live in-app camera. **Phone camera** and **Library** uploads still work. For the in-app camera, use HTTPS as described below.

## Updating

When a new release is published, the **Docker** page shows an update for PakTrak. Choose **apply update**. The container restarts on the new version, updates the database and keeps your data.

## Using HTTPS

If you run a reverse proxy on Unraid with a hostname and certificate, point it at `http://YOUR-SERVER-IP:8095` and allow uploads of at least 100 MB. Then edit the PakTrak container, change **App address** to the HTTPS address, for example `https://cards.example.net`, and apply. Accounts and collections are kept; sign in again at the new address.

## Where your data lives

The **Data** folder holds the database, your photos and `paktrak.env`, which contains the container's private passwords. Keep it private. To back up, stop the container and copy the whole folder, or use a backup plugin that does the same. Restoring the folder and starting the container brings everything back.

## Moving from a Docker Compose installation

If PakTrak already runs on this server with Docker Compose, move its data into the single container instead of starting fresh. Your accounts, collections, decks and photos come with it.

1. Finish or cancel any scans that are still processing.
2. Add the template as in step 1 above, but don't create the container yet. It must not start on an empty Data folder first.
3. In the terminal, run:

   ```sh
   curl -fsSL https://raw.githubusercontent.com/Addison16/PakTrak/main/scripts/move-to-single-container.sh | sh -s -- /mnt/user/appdata/paktrak
   ```

   The script finds the Compose installation, stops it, and copies its database, photos and passwords into the folder. It prints the address the installation used.
4. Create the container from the template with that address as **App address** and the same folder as **Data**.

The old containers stay stopped and their data volumes are not changed, so you can go back by starting them again. If you manage the old installation with a Compose plugin, turn off its autostart so it doesn't take port 8095 back after a reboot. Once the new container works, you can remove the old stack and its volumes.

If more than one Compose installation exists, the script asks for `--project NAME`. If it can't find the old `.env` file, pass its path with `--env /path/to/.env`.

## Docker Compose on Unraid

The Compose installation runs each service in its own container and is updated from the terminal. Unraid has no Git, so you unpack PakTrak from a download, and `sh scripts/update.sh` downloads each new release the same way.

1. In the **Apps** tab, install **Docker Compose Manager**. It adds the `docker compose` command.
2. In the terminal, download the setup scripts:

   ```sh
   mkdir -p /mnt/user/appdata/paktrak-compose
   cd /mnt/user/appdata/paktrak-compose
   curl -fsSL https://github.com/Addison16/PakTrak/archive/refs/heads/main.tar.gz | tar -xz --strip-components=1
   ```

3. Set up and start, using your server's address (`--bind 0.0.0.0` lets other devices reach port 8095, and `--allow-http` permits a plain HTTP address other than `localhost`):

   ```sh
   sh scripts/setup.sh --url http://192.168.1.50:8095 --bind 0.0.0.0 --allow-http
   sh scripts/update.sh
   ```

   For HTTPS, pass `--url https://cards.example.net` without `--allow-http`.

To update later, back up and run the updater:

```sh
cd /mnt/user/appdata/paktrak-compose
sh scripts/backup.sh /mnt/user/backups/paktrak-$(date +%Y%m%d)
sh scripts/update.sh
```

`.env` in that folder holds the private passwords. Your collection and photos live in Docker volumes inside Unraid's Docker storage (**Settings → Docker**), so recreating that storage deletes them; take a backup first. The containers restart when Docker starts. Use `sh scripts/start.sh` rather than the per-container buttons, so the services start in the right order. To change the address later, edit `APP_URL` in `.env` and run `sh scripts/start.sh`; see [changing the hostname](OPERATIONS.md#https-and-access-from-a-phone).
