# Deploying mednotice-india to AWS EC2

Live demo (deployed from this directory): **http://13.238.116.94/** — Sydney,
`t3.micro`, no custom domain, plain HTTP.

MedNotice Global runs on its own instance (**http://54.206.39.199/**,
`i-085640db7a6f9ead8`). See `mednotice-global/infra/README.md` for that stack,
its redeploy steps and the free-tier limits of running both at once.

```bash
set -a; . ../.env; set +a          # AWS_ACCESS_KEY_ID / SECRET / AWS_DEFAULT_REGION
export PATH="/tmp/bin:$PATH"       # terraform 1.9.8 installed under /tmp/bin
terraform init
terraform apply                    # key pair + instance (see "what this account allows")
./verify.sh 13.238.116.94 ../infra/terraform-key.pem
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

`terraform apply` created the instance (`i-09591a814f5600b70`) but then failed to *read it back*
(`ec2:DescribeInstanceAttribute` is denied), so **the instance is not in `terraform.tfstate`**.
`terraform destroy` will therefore not remove it. Either:

* grant `ec2:DescribeInstanceAttribute` (and `ec2:DescribeInstanceCreditSpecifications`) to the
  user, then `terraform import aws_instance.app i-09591a814f5600b70`; or
* delete it by hand: terminate the instance, then delete the security group, key pair, role and
  instance profile listed above.

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
ssh -i terraform-key.pem ubuntu@13.238.116.94 'set -e
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
PUBLIC_URL=http://13.238.116.94
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

## Verified after deploy

Deployed from commit `99e3a70` ("Notify registered patients over WhatsApp when a case is filed and when it changes").

| Check | Result |
| --- | --- |
| `http://13.238.116.94/api/health` | 200, `auditChain.valid: true` |
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
* No Elastic IP: the public address changes if the instance is stopped and started.
