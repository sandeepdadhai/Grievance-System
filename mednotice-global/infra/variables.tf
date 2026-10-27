variable "region" {
  description = "AWS region (same as the MedNotice India instance, so the shared VPC/subnet apply)"
  default     = "ap-southeast-2"
}

variable "instance_type" {
  description = "Free-tier eligible always-on instance class"
  default     = "t3.micro"
}

variable "volume_size_gb" {
  description = "Persistent data volume (SQLite DB, uploads, master key)"
  default     = 8
}

variable "root_volume_size_gb" {
  description = "Root volume size"
  default     = 10
}

variable "public_key_path" {
  description = "OpenSSH public key registered as the EC2 key pair"
  default     = "mednotice-global-aws.pub"
}

variable "key_name" {
  description = "EC2 key pair name"
  default     = "mednotice-global-aws"
}

variable "vpc_id" {
  description = "Existing default VPC in ap-southeast-2 (the SCP denies the describe calls a data source needs)"
  default     = "vpc-0ecac89d4da68800a"
}

variable "subnet_id" {
  description = "Default subnet in ap-southeast-2a inside that VPC"
  default     = "subnet-0050c120a0c569c09"
}

variable "iam_instance_profile_name" {
  description = "Instance profile with AmazonSSMManagedInstanceCore (created once by the India bootstrap)"
  default     = "mednotice-ssm-profile"
}

variable "security_group_id" {
  description = "Security group allowing 22/80/443 (created once by the India bootstrap)"
  default     = "sg-0e5c7eabe2378ffa5"
}

variable "git_commit" {
  description = "Commit of sandeepdadhai/Grievance-System to deploy"
  default     = "main"
}
