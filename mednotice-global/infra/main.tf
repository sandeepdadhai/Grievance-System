terraform {
  required_version = ">= 1.5"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

provider "aws" {
  region = var.region
}

# Same account constraints as the MedNotice India stack: the organisation SCP
# denies most EC2/IAM read calls, so the VPC, subnet, security group and SSM
# instance profile are passed in as variables instead of being looked up, and
# Terraform only creates the key pair and the instance itself.
data "aws_ami" "ubuntu" {
  most_recent = true
  owners      = ["099720109477"] # Canonical
  filter {
    name   = "name"
    values = ["ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-amd64-server-*"]
  }
  filter {
    name   = "virtualization-type"
    values = ["hvm"]
  }
  filter {
    name   = "architecture"
    values = ["x86_64"]
  }
}

resource "aws_key_pair" "ec2" {
  key_name   = var.key_name
  public_key = file(var.public_key_path)
  tags       = { Project = "mednotice-global" }
}

resource "aws_instance" "app" {
  ami                         = data.aws_ami.ubuntu.id
  instance_type               = var.instance_type
  subnet_id                   = var.subnet_id
  vpc_security_group_ids      = [var.security_group_id]
  key_name                    = aws_key_pair.ec2.key_name
  iam_instance_profile        = var.iam_instance_profile_name
  associate_public_ip_address = true
  user_data                   = filebase64("${path.module}/user-data.sh")

  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required"
    http_put_response_hop_limit = 1
  }

  # Persistent data volume: SQLite DB, encrypted uploads, outbox, master key.
  ebs_block_device {
    device_name           = "/dev/sdf"
    volume_size           = var.volume_size_gb
    volume_type           = "gp3"
    delete_on_termination = true
  }

  root_block_device {
    volume_size = var.root_volume_size_gb
    volume_type = "gp3"
  }

  tags = { Name = "mednotice-global", Project = "mednotice-global" }
}
