output "instance_id" {
  value = aws_instance.app.id
}

output "public_ip" {
  value = aws_eip.app.public_ip
}

output "deploy_role_arn" {
  value = aws_iam_role.deploy.arn
}

output "ecr_registry" {
  value = "${data.aws_caller_identity.current.account_id}.dkr.ecr.${var.region}.amazonaws.com"
}
