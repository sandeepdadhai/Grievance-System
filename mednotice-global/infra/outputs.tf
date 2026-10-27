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
  value = "http://${aws_instance.app.public_ip}:4200/"
}

output "ssh_command" {
  value = "ssh -i terraform-key.pem ubuntu@${aws_instance.app.public_ip}"
}
