variable "region" {
  description = "AWS region"
  default     = "ap-southeast-2"
}

variable "instance_type" {
  description = "Cheapest always-on general purpose instance"
  default     = "t3.micro"
}

variable "app_port" {
  description = "Port the Node app listens on"
  default     = 4100
}

variable "volume_size_gb" {
  description = "Persistent data volume (SQLite DB, uploads, master key)"
  default     = 10
}

variable "ssh_cidr" {
  description = "CIDR allowed to reach SSH. Restrict this to your own IP after the first connect."
  default     = "0.0.0.0/0"
}

variable "public_key_path" {
  description = "OpenSSH public key registered as the EC2 key pair"
  default     = "mednotice-aws.pub"
}

variable "vpc_id" {
  description = "Existing default VPC in ap-southeast-2 (resolved once, because the SCP denies the describe calls the data source needs)"
  default     = "vpc-0ecac89d4da68800a"
}

variable "subnet_id" {
  description = "Default subnet in ap-southeast-2a inside that VPC"
  default     = "subnet-0050c120a0c569c09"
}

variable "iam_instance_profile_name" {
  description = "Instance profile created by infra/bootstrap-ssm.sh (Terraform cannot read IAM roles in this account)"
  default     = "mednotice-ssm-profile"
}

variable "security_group_id" {
  description = "Security group created by infra/bootstrap.sh (Terraform cannot revoke the default egress rule in this account)"
  default     = "sg-0e5c7eabe2378ffa5"
}

variable "git_commit" {
  description = "Commit of sandeepdadhai/Grievance-System to deploy"
  default     = "cc660efc854b1ae79110992fc8e083b1c7b1e306"
}
