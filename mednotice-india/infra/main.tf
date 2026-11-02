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

# This account runs under an organisation SCP that denies most EC2 read calls
# outside ap-southeast-2, and denies a few IAM read calls outright. So:
#   * the VPC / subnet are passed in as variables instead of looked up;
#   * the SSM role and instance profile are created once by
#     infra/bootstrap-ssm.sh and referenced by name here;
#   * the security group manages ingress only and leaves the default egress.
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
  key_name   = "mednotice-aws"
  public_key = file(var.public_key_path)
  tags       = { Project = "mednotice-india" }
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
    volume_size = 12
    volume_type = "gp3"
  }

  tags = { Name = "mednotice-india", Project = "mednotice-india" }
}

# Static public IPv4, so the patient and console URLs survive the nightly
# stop/start. Associating an Elastic IP replaces the auto-assigned public
# address rather than adding a second one, so it costs exactly what the dynamic
# address already costs: the free tier covers 750 h/month of public IPv4 for the
# first 12 months, after that ~US$0.005/h (~US$3.65/month) whether it is
# dynamic or elastic.
resource "aws_eip" "app" {
  domain   = "vpc"
  instance = aws_instance.app.id

  tags = { Name = "mednotice-india-eip", Project = "mednotice-india" }
}
