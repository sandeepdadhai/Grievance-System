output "instance_id" {
  value = aws_instance.app.id
}

output "public_ip" {
  value = aws_instance.app.public_ip
}

output "public_dns" {
  value = aws_instance.app.public_dns
}

output "app_url_http" {
  value = "http://${aws_instance.app.public_ip}/"
}

output "app_url_direct" {
  value = "http://${aws_instance.app.public_ip}:4100/"
}

output "ssh_command" {
  value = "ssh -i infra/terraform-key.pem ubuntu@${aws_instance.app.public_ip}"
}

output "ssm_command" {
  value = "aws ssm start-session --target ${aws_instance.app.id} --region ${var.region}"
}
