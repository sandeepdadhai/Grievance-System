#!/usr/bin/env bash
#
# Give the MedNotice instance a static public IPv4 (Elastic IP).
#
# Why: the instance stops every night and starts again in the morning, and
# without an Elastic IP each start hands out a new public address — which breaks
# the patient URL, the console URL, PUBLIC_URL in /etc/mednotice.env and every
# WhatsApp link already sent. An Elastic IP stays attached across stop/start.
#
# Cost: this is free-tier friendly. Associating an Elastic IP REPLACES the
# auto-assigned public address, so it is still exactly one public IPv4 for the
# instance. The EC2 free tier includes 750 h/month of public IPv4 for the first
# 12 months (the instance runs ~365 h/month, ~730 h including the stopped hours
# the attached address is still counted); after that it is ~US$0.005/h
# (~US$3.65/month) — the same as the dynamic address it replaces, not extra.
#
# Permissions: the IAM user needs ec2:DescribeAddresses, ec2:AllocateAddress,
# ec2:AssociateAddress (and ec2:ReleaseAddress / ec2:DisassociateAddress to undo
# it). See iam-policy.json in this directory.
#
# Usage:
#   set -a; . ../.env; set +a        # AWS_ACCESS_KEY_ID / SECRET / AWS_DEFAULT_REGION
#   ./elastic-ip.sh
#
# Idempotent: if an address is already associated with the instance it just
# prints it; a free (unassociated) allocation is reused instead of allocating a
# second one.

set -euo pipefail

REGION="${AWS_DEFAULT_REGION:-ap-southeast-2}"
INSTANCE_ID="${INSTANCE_ID:-i-09591a814f5600b70}"
TAG_NAME="${TAG_NAME:-mednotice-india-eip}"

[ -n "${AWS_ACCESS_KEY_ID:-}" ] && [ -n "${AWS_SECRET_ACCESS_KEY:-}" ] || {
  echo "AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY are not set. Run: set -a; . ../.env; set +a" >&2
  exit 1
}

ec2() {
  curl -s -m 25 --aws-sigv4 "aws:amz:${REGION}:ec2" \
    --user "${AWS_ACCESS_KEY_ID}:${AWS_SECRET_ACCESS_KEY}" \
    -X POST "https://ec2.${REGION}.amazonaws.com/" \
    --data-urlencode "Version=2016-11-15" "$@"
}

# Prints the <Message> of an error response and exits; passes normal responses
# through untouched.
check() {
  local body="$1"
  if grep -q '<Error>' <<<"$body"; then
    local code msg
    code=$(sed -n 's:.*<Code>\([^<]*\)</Code>.*:\1:p' <<<"$body")
    msg=$(sed -n 's:.*<Message>\([^<]*\)</Message>.*:\1:p' <<<"$body")
    echo >&2
    echo "AWS refused the request: ${code:-Error}" >&2
    echo "  ${msg}" >&2
    case "$code" in
      AuthFailure|InvalidClientTokenId|SignatureDoesNotMatch|ExpiredToken)
        echo >&2
        echo "  The access key itself is not valid. Create a new key for the IAM user and put it" >&2
        echo "  in ../.env, then run this script again." >&2
        ;;
      UnauthorizedOperation)
        echo >&2
        echo "  The key works but is not allowed to manage addresses. Attach the ec2:DescribeAddresses," >&2
        echo "  ec2:AllocateAddress and ec2:AssociateAddress actions (iam-policy.json), or allocate and" >&2
        echo "  associate the address in the EC2 console: Elastic IPs -> Allocate Elastic IP address," >&2
        echo "  then Actions -> Associate Elastic IP address -> instance ${INSTANCE_ID}." >&2
        ;;
    esac
    exit 1
  fi
  printf '%s' "$body"
}

field() { sed -n "s:.*<$1>\([^<]*\)</$1>.*:\1:p" <<<"$2"; }

echo "== Elastic IP for ${INSTANCE_ID} (${REGION}) =="

resp=$(check "$(ec2 --data-urlencode "Action=DescribeAddresses")")

alloc=""
ip=""
free_alloc=""
free_ip=""

# One <item> per address: reassemble a line per item so field() can read it.
while IFS= read -r item; do
  a=$(field allocationId "$item")
  i=$(field instanceId "$item")
  p=$(field publicIp "$item")
  [ -n "$a" ] || continue
  if [ "$i" = "$INSTANCE_ID" ]; then
    alloc="$a"; ip="$p"
  elif [ -z "$i" ] && [ -z "$free_alloc" ]; then
    free_alloc="$a"; free_ip="$p"
  fi
done < <(tr '\n' ' ' <<<"$resp" | sed 's:</item>:</item>\n:g' | grep '<item>')

if [ -n "$alloc" ]; then
  echo "   already associated: ${ip} (${alloc})"
else
  if [ -n "$free_alloc" ]; then
    alloc="$free_alloc"; ip="$free_ip"
    echo "   reusing unassociated address ${ip} (${alloc})"
  else
    echo "   allocating a new address tagged Name=${TAG_NAME}"
    out=$(check "$(ec2 \
      --data-urlencode "Action=AllocateAddress" \
      --data-urlencode "Domain=vpc" \
      --data-urlencode "TagSpecification.1.ResourceType=elastic-ip" \
      --data-urlencode "TagSpecification.1.Tag.1.Key=Name" \
      --data-urlencode "TagSpecification.1.Tag.1.Value=${TAG_NAME}")")
    alloc=$(field allocationId "$out")
    ip=$(field publicIp "$out")
    [ -n "$alloc" ] || { echo "   could not read the new allocation id from AWS" >&2; exit 1; }
    echo "   allocated ${ip} (${alloc})"
  fi

  echo "   associating with ${INSTANCE_ID}"
  check "$(ec2 \
    --data-urlencode "Action=AssociateAddress" \
    --data-urlencode "InstanceId=${INSTANCE_ID}" \
    --data-urlencode "AllocationId=${alloc}")" >/dev/null
  echo "   associated"
fi

cat <<TXT

  Elastic IP     ${ip}
  Allocation     ${alloc}
  Instance       ${INSTANCE_ID}

  This address now survives stop/start, so use it everywhere instead of the
  rotating one:

    1. scripts/deploy.sh      SSH_HOST="${ip}"  PUBLIC_URL="http://${ip}"
    2. npm run deploy         (rebuilds the bundles with the new console URL)
    3. security group         inbound TCP 80, and TCP 4100 for the staff console

  Open the patient app: http://${ip}/
  Open the console:     http://${ip}:4100/admin
TXT
