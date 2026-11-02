output "instance_id" {
  value = aws_instance.app.id
}

# The Elastic IP, not the instance's auto-assigned address: this one survives
# stop/start, so it is the address the URLs and the deploy script should use.
output "public_ip" {
  value = aws_eip.app.public_ip
}

output "allocation_id" {
  value = aws_eip.app.allocation_id
}

output "public_dns" {
  value = aws_eip.app.public_dns
}

output "app_url_http" {
  value = "http://${aws_eip.app.public_ip}/"
}

output "app_url_direct" {
  value = "http://${aws_eip.app.public_ip}:4100/"
}

output "ssh_command" {
  value = "ssh -i infra/terraform-key.pem ubuntu@${aws_eip.app.public_ip}"
}

output "ssm_command" {
  value = "aws ssm start-session --target ${aws_instance.app.id} --region ${var.region}"
}
