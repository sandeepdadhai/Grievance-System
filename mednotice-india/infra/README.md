# Deploying mednotice-india to AWS EC2

Live demo (deployed from this directory): **http://54.79.127.229/** — Sydney,
`t3.micro`, no custom domain, plain HTTP, instance `i-07f6a58b57ebf1fb4`.

That is the instance's **auto-assigned** public IPv4: the Elastic IP could not
be re-attached after the 2026-11-05 rebuild because `ec2:AssociateAddress` is
now denied for `samagent`. A stop/start therefore changes the address and the
URL until either that permission is granted or the address is attached in the
console (EC2 → Elastic IPs → Associate).

The MedNotice Global instance (`i-085640db7a6f9ead8`) was **terminated on
2026-10-28**; its code stays in the repository but nothing is deployed for it.
Only this instance remains, so the free tier has room for a 12-hour day.

## Power schedule (11:00 → 23:00 Hong Kong time)

The instance stops itself every night and is started again each morning, so it
runs roughly 365 h a month and stays inside the 750 h free tier.

| What | Where | When |
| --- | --- | --- |
| Start | `.github/workflows/ec2-schedule.yml` (`aws ec2 start-instances`) | `0 3 * * *` UTC = 11:00 HKT |
| Stop | same workflow (`aws ec2 stop-instances`) | `0 15 * * *` UTC = 23:00 HKT |
| Stop backstop | `/etc/cron.d/mednotice-shutdown` on the instance | 23:05 HKT, in case the workflow fails |

This account's credentials **cannot** create AWS-native schedules:
`scheduler:*`, `events:PutRule`, `lambda:*`, `autoscaling:*` and `iam:PassRole`
are all denied (verified 2026-10-28). The GitHub Actions workflow is therefore
the external clock — it needs two repository secrets under *Settings → Secrets
and variables → Actions*: `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY`. Until
they exist the scheduled job exits without doing anything and the instance stays
asleep after its nightly stop.

Start it by hand at any time:

```bash
aws ec2 start-instances --region ap-southeast-2 --instance-ids i-07f6a58b57ebf1fb4
aws ec2 describe-instances --region ap-southeast-2 --instance-ids i-07f6a58b57ebf1fb4 \
  --query 'Reservations[0].Instances[0].PublicIpAddress' --output text
```

`PUBLIC_URL` in `/etc/mednotice.env` must match, which is exactly what the
Elastic IP below is for.

## Elastic IP (static address)

**Not attached since the 2026-11-05 rebuild.** The previous address
`3.104.125.124` was left allocated when the terminated instance was cleaned up
(`ec2:ReleaseAddress` is denied for `samagent`), and `ec2:AssociateAddress` is
denied too, so `elastic-ip.sh` cannot re-attach it. Release that idle address in
the console so it stops billing, and attach an Elastic IP by hand if the URL
must survive the nightly stop/start.

`elastic-ip.sh` still works in an account where the associate/release actions
are allowed; it reuses an associated address rather than allocating a second
one:

```bash
set -a; . ../.env; set +a      # AWS_ACCESS_KEY_ID / SECRET / AWS_DEFAULT_REGION
./elastic-ip.sh                # allocate (or reuse) + associate, idempotent
```

It prints the address, then you point the deploy script at it and redeploy:

```bash
# scripts/deploy.sh
SSH_HOST="<the address>"
PUBLIC_URL="http://<the address>"
```

```bash
npm run deploy                 # rebuilds both bundles with the new console URL
```

**Free tier.** An Elastic IP *replaces* the auto-assigned public IPv4 instead of
adding a second one, so it is the same single address the instance already has:
the EC2 free tier covers 750 h/month of public IPv4 for the first 12 months, and
after that it is ~US$0.005/h (~US$3.65/month) — identical to the dynamic address,
not an extra charge. The instance runs ~365 h/month; the stopped hours still
count against the 750 h because the address stays attached, so the monthly total
is ~730 h and fits.

**Permissions.** This account's IAM user previously had `ec2:AllocateAddress`
denied, which is why the first deployment had none. `iam-policy.json` in this
directory now includes `ec2:DescribeAddresses`, `ec2:AllocateAddress`,
`ec2:AssociateAddress`, `ec2:DisassociateAddress` and `ec2:ReleaseAddress`;
attach that policy to the user (or grant just those five actions), then run the
script. `terraform apply` creates the same address from `aws_eip.app` if you
prefer Terraform. No script, console-only equivalent: **EC2 → Elastic IPs →
Allocate Elastic IP address → Associate Elastic IP address →** instance
`i-09591a814f5600b70`.

To undo it: disassociate and release in the console (an unassociated Elastic IP
is billed the same daily rate, so don't leave one lying around).

## Patient identity: SMS OTP and Aadhaar

The patient-facing identity features run in **simulation** until gateway
credentials exist, exactly like the WhatsApp channel:

| Feature | Endpoint | Behaviour now |
| --- | --- | --- |
| One-time-password login | `POST /api/auth/otp/request`, `POST /api/auth/otp/verify` | One field takes a mobile number or an email address; 6-digit code, 5-minute TTL, 5 attempts. SMS goes to `/var/lib/mednotice/outbox/sms-*.txt`, email to `email-*.txt`, both echoed as `devCode` because no gateway is configured |
| Aadhaar verification | `POST /api/auth/aadhaar/request`, `POST /api/auth/aadhaar/verify` | 12-digit number + Verhoeff checksum, then an OTP to the mobile number on the account; stored AES-256-GCM encrypted with only `XXXX XXXX 1234` ever displayed |
| Aadhaar gate on submissions | `POST /api/cases` | A signed-in patient without a verified Aadhaar gets `403` with `details.code = AADHAAR_REQUIRED`; guest submissions stay anonymous and are unaffected |

The demo patient accounts are seeded with a mobile number and a verified dummy
Aadhaar (`USR-PATIENT` → `9810000123`, `XXXX XXXX 2644`). To send real SMS, put
`SMS_PROVIDER=generic`, `SMS_API_URL`, `SMS_API_KEY` (or the `SMS_TWILIO_*` trio)
in `/etc/mednotice.env` and restart; for email sign-in set `EMAIL_API_URL` and
`EMAIL_API_KEY` the same way. See `.env.example`.

```bash
set -a; . ../.env; set +a          # AWS_ACCESS_KEY_ID / SECRET / AWS_DEFAULT_REGION
export PATH="/tmp/bin:$PATH"       # terraform 1.9.8 installed under /tmp/bin
terraform init
terraform apply                    # key pair + instance + Elastic IP (see "what this account allows")
./verify.sh 3.104.125.124 ../infra/terraform-key.pem
```

## What this account allows

The credentials belong to `arn:aws:iam::285050838656:user/samagent`, an account inside an AWS
Organization whose SCP (`o-avls9kja4r` / `p-ozyjf7ok`) **explicitly denies EC2 outside
`ap-southeast-2`**. Verified: EC2 describes succeed in Sydney and are SCP-denied in 17 other
regions. That is why the region is Sydney and not `ap-southeast-1`.

The SCP/IAM combination also denies several reads Terraform normally needs, so three things are
created **outside Terraform** by `./bootstrap.sh` and referenced by id/name:

| Resource | Why it is not in Terraform | Where it is referenced |
| --- | --- | --- |
| SSM role `mednotice-ssm-role` + profile `mednotice-ssm-profile` | `iam:ListRolePolicies` is denied, so the role resource can never finish reading itself | `var.iam_instance_profile_name` |
| Security group `mednotice-sg` | Terraform always revokes the default egress rule on create, and `ec2:RevokeSecurityGroupEgress` is denied | `var.security_group_id` |
| VPC / subnet ids | `ec2:DescribeVpcAttribute`, `DescribeRouteTables`, `DescribeInternetGateways` are denied | `var.vpc_id`, `var.subnet_id` |

Run `./bootstrap.sh` once in a fresh account (it is idempotent and prints the two ids to put in
`terraform.tfvars`).

## Terraform state caveat

The 2026-11-05 rebuild ran `terraform apply` and it created the instance
(`i-07f6a58b57ebf1fb4`) but then failed to *read it back*: `ec2:DescribeInstanceAttribute` is
now denied. The instance **is** recorded in `terraform.tfstate`, but no later `apply`, `plan`
or `destroy` can refresh it, and `aws_eip.app` was never created because the run aborted first.

So treat the instance as unmanaged until the IAM user can read attributes again:

* grant `ec2:DescribeInstanceAttribute` (and `ec2:DescribeInstanceCreditSpecifications`), then
  `terraform import aws_eip.app <allocation-id>` after associating an address; or
* operate it with the AWS CLI / console, as the rebuild did — the deploy path is
  `scripts/deploy.sh` with `SSH_HOST` set to the current public IPv4.

## What the instance does at boot (`user-data.sh`)

1. adds 1 GiB swap (t3.micro has 1 GiB RAM; the Vite/tsc build needs headroom)
2. installs Node 24 from NodeSource (`node:sqlite` needs 22.5+)
3. clones `github.com/sandeepdadhai/Grievance-System` at `cc660efc…` into `/srv/mednotice`
4. `npm ci && npm run build`
5. formats and mounts `/dev/nvme1n1` (the 10 GB `gp3` data volume) at `/var/lib/mednotice`
6. writes `/etc/mednotice.env` (`DATA_DIR=/var/lib/mednotice`, `PORT=4100`) and a systemd unit
7. installs Caddy and proxies port 80 → `127.0.0.1:4100`
8. waits until `/api/health` reports `"valid":true`

`DATA_DIR` holds the SQLite database, the AES-encrypted uploads, the outbox and the generated
master key, so **the data volume is the whole state** — snapshot it before any migration.

## Deploying new code

The instance tracks `origin/main`, so an update is three commands:

```bash
ssh -i terraform-key.pem ubuntu@3.104.125.124 'set -e
  cd /srv/mednotice/Grievance-System && sudo git fetch origin main && sudo git checkout -f origin/main
  cd mednotice-india && sudo npm ci --no-audit --no-fund && sudo npm run build
  sudo systemctl restart mednotice'
```

Schema migrations and the facility demo accounts are applied by `seed()` at boot, so a restart is
enough — the SQLite file on the data volume is kept.

## Environment on the instance

Runtime configuration lives in `/etc/mednotice.env` (read by the systemd unit). Edit it and
`sudo systemctl restart mednotice` to apply. Current contents:

```
NODE_ENV=development
DATA_DIR=/var/lib/mednotice
PORT=4100
PUBLIC_URL=http://3.104.125.124
```

`PUBLIC_URL` is what WhatsApp messages link back to; update it when a domain is attached. The
WhatsApp channel needs two more values to leave simulation:

```
WHATSAPP_TOKEN=<permanent System User token>
WHATSAPP_PHONE_NUMBER_ID=<phone number id>
```

Without them the channel stays in simulation: the message payload is written to
`/var/lib/mednotice/outbox/*.wa.json` and recorded as `SENT` with provider `OUTBOX`, so a reviewer can
see exactly what would have been delivered. Keep the token out of the repo — it belongs only in this
file (mode `0600`).

## Verified after the 2026-11-05 rebuild

| Check | Result |
| --- | --- |
| `http://54.79.127.229/` | 200, title "Health & Family Welfare Department, Government of Assam · Patient grievance portal" |
| `/api/health` | 200, `auditChain.valid: true` over 27,571 rows after the restore |
| `/assam/emblem.svg`, `/assam/favicon.svg`, `/assam/banner-gmch.jpg` | 200 |
| staff console `http://54.79.127.229:4100/admin` | 401 Basic-auth challenge from outside the VM; local 4100 returns 401 as designed |
| data restored | `mednotice-backup-20261105.tar.gz` extracted into `/var/lib/mednotice` (sqlite, `storage/`, `outbox/`, `.master.key`) |
| deploy | `GIT_BRANCH=develop_assam scripts/deploy.sh` → commit `557dc13`, both services active |

The deploy script reports the console as unreachable (`000`) when it runs from a sandbox
that blocks outbound port 4100 — check it from a normal network before treating that as a fault.

## Verified after an earlier deploy

Deployed from commit `99e3a70` ("Notify registered patients over WhatsApp when a case is filed and when it changes").

| Check | Result |
| --- | --- |
| `http://3.104.125.124/api/health` | 200, `auditChain.valid: true` |
| `/`, `/login`, `/admin/facility`, `/admin/dispatch`, `/admin/directory` | all 200, SPA bundle `index-WcWXxoZ1.js` |
| sign-in `admin@mednotice.in` / `Admin!2345` | 200 + session cookie |
| sign-in `facility.aiims@mednotice.in` / `Facility!2345` | 200, `/api/admin/facility` returns FAC-IN-001 |
| cross-facility read (AIIMS → KEM case) | 403 |
| data volume | `/dev/nvme1n1` ext4 mounted at `/var/lib/mednotice`, 9.8 GB |
| `systemctl restart mednotice` | service active, same cases and valid audit chain afterwards |
| WhatsApp on submit | new patient opted in with `+91 98100 01234`, filed `CASE-2026-GBGL42` → notification `SENT`, `provider_ref OUTBOX:NTF-…wa.json` |
| WhatsApp on status change | admin resolve → second message "… is now Resolved", delivered within one worker tick |
| WhatsApp payload | outbox JSON carries the case, status, outcome and the `PUBLIC_URL` link; `to: +919810001234` |
| WhatsApp hygiene | 0 audit rows contain the clear number (`+91 ******1234` only), `users.phone_enc` starts `v1:` (encrypted) |
| Communications log | `/api/admin/communications` lists both messages with the masked target and `NOTIFICATION_SENT` audit link |
| SSM agent | snap active, "Set up control channel successfully" |

## Staff console (separate frontend)

`npm run build` produces two bundles: `client/dist/patient` (public) and `client/dist/admin` (staff).
They are served by two processes from the same code and the same database:

```bash
systemctl status mednotice        # patient app + API on :4100 (public via Caddy)
systemctl status mednotice-admin  # staff console + API on 127.0.0.1:4101 (loopback only)
```

To use the console, tunnel the loopback port and open it locally — nothing on 4101 is reachable from
the internet, because the process binds to loopback and the security group does not open that port:

```bash
ssh -i infra/terraform-key.pem -L 4101:127.0.0.1:4101 ubuntu@<public-ip>
# then http://localhost:4101 — staff accounts only, patient accounts are signed out
```

If several staff members need browser access, publish it through Caddy with an extra restriction and
set the matching app-level values in `/etc/mednotice.env` (`ADMIN_ALLOWED_IPS`, or
`ADMIN_BASIC_USER` + `ADMIN_BASIC_PASSWORD`):

```caddy
admin.example.org {
	basic_auth {
		# caddy hash-password --plaintext 'choose-a-strong-password'
		ops <bcrypt-hash>
	}
	reverse_proxy 127.0.0.1:4101
}
```

## Known limitations

* **Plain HTTP only.** Caddy is serving `:80`; Let's Encrypt cannot issue a certificate for an
  `amazonaws.com` hostname, so TLS needs a domain you control pointed at an Elastic IP.
* **`NODE_ENV=development` on the instance.** With `NODE_ENV=production` the session cookie is
  `Secure`, so it is discarded over plain HTTP and every authenticated request returns 401. Switch
  it back to `production` the moment HTTPS exists.
* **The instance runs `origin/main`.** Nothing is deployed automatically — run the update commands above
  after pushing.
* **SSH and the app port are open to `0.0.0.0/0`.** Restrict with
  `var.ssh_cidr`, and drop the 4100 rule once Caddy is the only entry point.
* **The address is dynamic until `./elastic-ip.sh` is run.** Once the Elastic IP is attached the URL stops
  changing across the nightly stop/start; before that every start invalidates links already sent.
