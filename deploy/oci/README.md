# CacheLoom — Oracle Cloud Always Free staging

This deploys the **experimental release candidate**, not a production migration.
The VM runs Docker Compose with restart policies, a private Node.js API service
and Caddy providing HTTPS. PostgreSQL remains on a **separate staging database**.

## 1. Create the Oracle instance

In the [Oracle Cloud Console](https://cloud.oracle.com/), create an **Always Free**
Compute VM using Ubuntu 24.04 LTS or a supported Oracle Linux image.
An Ampere A1 (ARM64) instance is suitable, subject to region capacity and
the current Always Free allowance. Check that the shape and boot volume both
say **Always Free** before creating anything; trial/paid resources can incur
charges. Enable public IPv4 and upload **your own SSH public key**.

Do not upgrade the account to Pay As You Go just to bypass free capacity errors.
Reserve the instance's public IPv4 address if your account offers it within the
free allowance. Oracle may reclaim idle Always Free compute; it is not an SLA.

On the VCN/Network Security Group, allow **TCP 80/443** publicly (for certificate
issuance and HTTPS), and **TCP 22 only from your own IP**. Do not expose 8080 or
PostgreSQL 5432. Check the VM's Ubuntu firewall as well: both the OCI network
rules and the OS firewall must permit 80/443.

## 2. Set up the VM

SSH as the default Ubuntu user, then install Docker Engine and the Docker Compose
plugin using the [official Docker Ubuntu instructions](https://docs.docker.com/engine/install/ubuntu/).
Prefer the official apt repository over unaudited convenience scripts.

```bash
sudo apt update && sudo apt upgrade -y
git clone https://github.com/Arpitruh/CacheLoom.git
cd CacheLoom
cp deploy/oci/.env.oci.example deploy/oci/.env.oci
chmod 600 deploy/oci/.env.oci
```

Use a **separate staging** Neon database. Edit `deploy/oci/.env.oci` with its
connection string and a unique 64-character secret. Do not copy production
database credentials, Auth Service keys, or Notification Service keys.

Create a DNS `A` record for `CACHELOOM_DOMAIN` that points at the VM's public IPv4.
Caddy needs this hostname to obtain a publicly trusted certificate.

## 3. Migrate and start

Run from the repository root:

```bash
docker compose --env-file deploy/oci/.env.oci -f deploy/oci/compose.yaml build
docker compose --env-file deploy/oci/.env.oci -f deploy/oci/compose.yaml run --rm --no-deps cacheloom npm run migrate
docker compose --env-file deploy/oci/.env.oci -f deploy/oci/compose.yaml up -d
docker compose --env-file deploy/oci/.env.oci -f deploy/oci/compose.yaml ps
docker compose --env-file deploy/oci/.env.oci -f deploy/oci/compose.yaml logs --tail=80 cacheloom caddy
```

The API port is reachable only from the Caddy container. Don't add a public
8080 port mapping. The server restarts after VM reboot if Docker starts normally
and the VM remains allocated.

## 4. Verify and monitor

```bash
curl --fail https://YOUR-DOMAIN/health
curl --fail https://YOUR-DOMAIN/ready
```

To test the full authenticated API, set the staging key in your current
shell and run `npm run smoke:staging` using HTTPS. The script deliberately
requires an explicit acknowledgment for remote staging:

```bash
CACHELOOM_STAGING_URL=https://YOUR-DOMAIN \
CACHELOOM_STAGING_KEY="$STAGING_KEY" \
CACHELOOM_ALLOW_REMOTE_SMOKE=I_UNDERSTAND_STAGING_ONLY npm run smoke:staging
```

The dashboard is at `https://YOUR-DOMAIN/dashboard`. Do not enter a production
API key. If you want a private dashboard, place it behind a VPN or an
authenticated access proxy before using it with sensitive data.

## 5. Updates, backups and troubleshooting

Never run `docker compose down -v` casually: that erases Caddy certificate
volumes. Pull changes and rebuild only after reviewing GitHub changes, re-run
migrations explicitly, then `up -d --build`. Restart policies prevent sleep,
but **cannot prevent Oracle from reclaiming an idle Always Free VM**.

Keep backups of the staging database independently of the VM. Validate restore
procedures periodically. Inspect `docker compose ... logs` and `/ready` if
requests fail. Do not switch production Auth Service or Notification Service
traffic to this deployment.
