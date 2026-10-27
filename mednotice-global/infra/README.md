# MedNotice Global — AWS EC2 deployment

Second, independent EC2 instance for **MedNotice Global**, alongside the existing
MedNotice India stack (`../../mednotice-india/infra`). Both run in the same AWS
account, region and default VPC, and share the SSM instance profile and security
group created once by the India bootstrap.

## Live URLs

| App | URL | Instance | Region | Type |
| --- | --- | --- | --- | --- |
| MedNotice India | <http://13.238.116.94/> | `i-09591a814f5600b70` | ap-southeast-2 (Sydney) | t3.micro |
| MedNotice Global | <http://54.206.39.199/> | `i-085640db7a6f9ead8` | ap-southeast-2 (Sydney) | t3.micro |

Direct app port (bypasses Caddy): <http://54.206.39.199:4200/api/health> is not
published by the security group, so use the Caddy URL above.

## What is on the instance

| Item | Value |
| --- | --- |
| Source directory | `/srv/mednotice/mednotice-global` |
| systemd unit | `mednotice-global.service` (Node 24, `dist/server/index.js`) |
| Runtime env file | `/etc/mednotice-global.env` (`PORT=4200`, `DATA_DIR=/var/lib/mednotice-global`, `PUBLIC_URL`, WhatsApp simulation) |
| Persistent data | `/var/lib/mednotice-global` on the dedicated gp3 data volume (`/dev/sdf`) |
| Reverse proxy | Caddy on `:80` → `127.0.0.1:4200` |

## Redeploy after a code change

The connected GitHub app cannot push to this repository, so the deployed tree is
copied from the working copy over SSH (the Terraform key pair is
`../mednotice-india/infra/terraform-key.pem`, registered on the instance as
`mednotice-global-aws`).

```bash
IP=54.206.39.199
SSH="ssh -o StrictHostKeyChecking=no -i mednotice-india/infra/terraform-key.pem"

# 1. copy the source (build output and data are excluded and rebuilt on the box)
rsync -az --delete -e "$SSH" \
  --exclude node_modules --exclude dist --exclude client/dist --exclude data \
  --exclude 'infra/.terraform' --exclude 'infra/terraform.tfstate*' --exclude 'infra/*.pem' \
  mednotice-global/ ubuntu@$IP:/srv/mednotice/mednotice-global/

# 2. install, build and restart
$SSH ubuntu@$IP 'cd /srv/mednotice/mednotice-global && npm ci --no-audit --no-fund && npm run build && sudo systemctl restart mednotice-global'

# 3. verify
curl -sS http://$IP/api/health
```

## Terraform

```bash
cd mednotice-global/infra
set -a; . ../../mednotice-india/.env; set +a      # AWS credentials
../../.tools/terraform init -plugin-dir=../../mednotice-india/infra/.terraform/providers
../../.tools/terraform plan
```

The account's organisation SCP denies `ec2:DescribeInstanceAttribute`, so a
plain `terraform apply` creates the instance and then errors while refreshing
that attribute. The instance is still created and recorded in state; treat the
error as expected and confirm with `DescribeInstances`.

## Free tier — read this before leaving both instances running

The AWS Free Tier gives **750 EC2 instance-hours per month in total**, not per
instance, plus **30 GB of EBS** and 100 GB of outbound data.

* Both instances are `t3.micro` and run 24/7 ≈ **1,490 hours/month**, roughly
  double the 750-hour allowance.
* Their volumes total 22 GB (India: 12 + 10) + 18 GB (Global: 10 + 8) = **40 GB**,
  above the 30 GB EBS allowance.

So one always-on instance fits in the free tier and the second one does not. To
stay at or near zero cost, stop one instance when it is not being reviewed:

```bash
# stop / start the Global instance (data volume and public IP set are kept)
curl -sS --aws-sigv4 "aws:amz:ap-southeast-2:ec2" --user "$AWS_ACCESS_KEY_ID:$AWS_SECRET_ACCESS_KEY" \
  "https://ec2.ap-southeast-2.amazonaws.com/?Action=StopInstances&Version=2016-11-15&InstanceId.1=i-085640db7a6f9ead8"
```

Note that a stopped-then-started instance normally keeps its Elastic IP only if
one is attached; without an Elastic IP the public address changes on restart.
Set `PUBLIC_URL` in `/etc/mednotice-global.env` again after such a restart so
WhatsApp message links point at the new address.

## Custom domain / HTTPS later

Point a DNS `A` record at the instance address and replace the Caddyfile with the
hostname; Caddy then obtains a Let's Encrypt certificate automatically:

```caddyfile
global.example.com {
	reverse_proxy 127.0.0.1:4200
}
```

Session cookies are only marked `Secure` when the request arrives over HTTPS, so
sign-in keeps working while the site is still served over plain HTTP.
