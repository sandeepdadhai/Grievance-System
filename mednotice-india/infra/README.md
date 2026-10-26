# Deploying mednotice-india to AWS EC2

Live demo (deployed from this directory): **http://13.238.116.94/** — Sydney,
`t3.micro`, no custom domain, plain HTTP.

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

## Verified after deploy

| Check | Result |
| --- | --- |
| `http://13.238.116.94/api/health` | 200, `auditChain.valid: true` |
| `http://13.238.116.94/` | 200, SPA bundle served by Caddy |
| sign-in `admin@mednotice.in` / `Admin!2345` | 200 + session cookie |
| `/api/admin/overview` | 200, 9 seeded cases |
| data volume | `/dev/nvme1n1` ext4 mounted at `/var/lib/mednotice`, 9.8 GB |
| `systemctl restart mednotice` | service active, same 9 cases and valid audit chain afterwards |
| SSM agent | snap active, "Set up control channel successfully" |

## Known limitations

* **Plain HTTP only.** Caddy is serving `:80`; Let's Encrypt cannot issue a certificate for an
  `amazonaws.com` hostname, so TLS needs a domain you control pointed at an Elastic IP.
* **`NODE_ENV=development` on the instance.** With `NODE_ENV=production` the session cookie is
  `Secure`, so it is discarded over plain HTTP and every authenticated request returns 401. Switch
  it back to `production` the moment HTTPS exists.
* **Older code than this workspace.** The instance runs commit `cc660efc`, which does not include
  the "My facility" section built here (`/api/admin/facility` returns 404 on the server).
* **SSH and the app port are open to `0.0.0.0/0`.** Restrict with
  `var.ssh_cidr`, and drop the 4100 rule once Caddy is the only entry point.
* No Elastic IP: the public address changes if the instance is stopped and started.
