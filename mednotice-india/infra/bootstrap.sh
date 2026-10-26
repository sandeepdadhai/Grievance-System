#!/usr/bin/env bash
#
# Creates the pieces Terraform cannot manage in this account, because the
# organisation SCP (o-avls9kja4r / p-ozyjf7ok) denies the read calls Terraform
# needs to take ownership of them:
#
#   * the SSM instance role + instance profile (Terraform cannot read role policies)
#   * the security group (Terraform insists on revoking the default egress rule,
#     which this account is not allowed to do)
#
# Everything is idempotent. Re-run it after `terraform destroy` if you want the
# same names back.
#
# Usage:  set -a; . ../.env; set +a; ./bootstrap.sh

set -euo pipefail

REGION="${AWS_DEFAULT_REGION:-ap-southeast-2}"
VPC_ID="${VPC_ID:-vpc-0ecac89d4da68800a}"
SG_NAME="${SG_NAME:-mednotice-sg}"
ROLE_NAME="${ROLE_NAME:-mednotice-ssm-role}"
PROFILE_NAME="${PROFILE_NAME:-mednotice-ssm-profile}"
SSM_POLICY="arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"

iam() {
  curl -s -m 25 -X POST --aws-sigv4 "aws:amz:us-east-1:iam" \
    --user "${AWS_ACCESS_KEY_ID}:${AWS_SECRET_ACCESS_KEY}" \
    --data-urlencode "Version=2010-05-08" "$@" "https://iam.amazonaws.com/"
}

ec2() {
  curl -s -m 25 --aws-sigv4 "aws:amz:${REGION}:ec2" \
    --user "${AWS_ACCESS_KEY_ID}:${AWS_SECRET_ACCESS_KEY}" \
    -X POST "https://ec2.${REGION}.amazonaws.com/" --data-urlencode "Version=2016-11-15" "$@"
}

echo "== SSM instance role =="
iam --data-urlencode "Action=CreateRole" \
    --data-urlencode "RoleName=${ROLE_NAME}" \
    --data-urlencode 'AssumeRolePolicyDocument={"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"ec2.amazonaws.com"},"Action":"sts:AssumeRole"}]}' \
  | grep -oE '<Code>[^<]*' | grep -v EntityAlreadyExists || true

iam --data-urlencode "Action=AttachRolePolicy" \
    --data-urlencode "RoleName=${ROLE_NAME}" \
    --data-urlencode "PolicyArn=${SSM_POLICY}" >/dev/null
echo "   attached AmazonSSMManagedInstanceCore"

iam --data-urlencode "Action=CreateInstanceProfile" \
    --data-urlencode "InstanceProfileName=${PROFILE_NAME}" >/dev/null 2>&1 || true

iam --data-urlencode "Action=AddRoleToInstanceProfile" \
    --data-urlencode "RoleName=${ROLE_NAME}" \
    --data-urlencode "InstanceProfileName=${PROFILE_NAME}" >/dev/null 2>&1 || true
echo "   instance profile ${PROFILE_NAME} -> ${ROLE_NAME}"

echo "== security group =="
SG_ID=$(ec2 --data-urlencode "Action=DescribeSecurityGroups" \
            --data-urlencode "Filter.1.Name=group-name" \
            --data-urlencode "Filter.1.Value.1=${SG_NAME}" \
  | grep -oE '<groupId>[^<]*' | head -1 | sed 's/<groupId>//')

if [ -n "$SG_ID" ]; then
  echo "   reusing ${SG_NAME} (${SG_ID})"
else
  SG_ID=$(ec2 --data-urlencode "Action=CreateSecurityGroup" \
              --data-urlencode "GroupName=${SG_NAME}" \
              --data-urlencode "GroupDescription=MedNotice India SSH HTTP HTTPS app" \
              --data-urlencode "VpcId=${VPC_ID}" \
    | grep -oE '<groupId>[^<]*' | head -1 | sed 's/<groupId>//')
  echo "   created ${SG_NAME} (${SG_ID})"

  for spec in "22:ssh" "80:http" "443:https" "4100:app"; do
    port="${spec%%:*}"
    ec2 --data-urlencode "Action=AuthorizeSecurityGroupIngress" \
        --data-urlencode "GroupId=${SG_ID}" \
        --data-urlencode "IpPermissions.1.IpProtocol=tcp" \
        --data-urlencode "IpPermissions.1.FromPort=${port}" \
        --data-urlencode "IpPermissions.1.ToPort=${port}" \
        --data-urlencode "IpPermissions.1.IpRanges.1.CidrIp=0.0.0.0/0" >/dev/null
  done
  echo "   opened 22, 80, 443, 4100"
fi

echo
echo "Put both of these into terraform.tfvars (see README) if they ever change:"
echo "  security_group_id        = \"${SG_ID}\""
echo "  iam_instance_profile_name = \"${PROFILE_NAME}\""
