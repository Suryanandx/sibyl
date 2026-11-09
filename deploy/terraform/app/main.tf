# The Sibyl app on AWS (app.opensibyl.world) — PREPARED, NOT DEPLOYED.
#
# One EC2 host running the production compose file (deploy/app): Caddy (HTTPS
# from Let's Encrypt), the web app, the gateway, Slides, and optionally the
# LiveKit realtime layer. No SSH: administration and deploys go through AWS
# Systems Manager. Data lives on its own EBS volume with daily snapshots.
# Images are built by GitHub Actions and pulled from ECR.
#
# Apply only when the hosted app is ready to launch (README.md, "The app").

terraform {
  required_version = ">= 1.10"
  required_providers {
    aws       = { source = "hashicorp/aws", version = "~> 6.0" }
    hostinger = { source = "hostinger/hostinger", version = "~> 0.1.23" }
  }
  backend "s3" {
    key          = "app/terraform.tfstate"
    region       = "eu-central-1"
    encrypt      = true
    use_lockfile = true
  }
}

provider "aws" {
  region = var.region
  default_tags { tags = { Project = "sibyl", ManagedBy = "terraform", Stack = "app" } }
}

provider "hostinger" {
  api_token = var.hostinger_api_token
}

data "aws_caller_identity" "current" {}

locals {
  app_host = "app.${var.domain}"
  rtc_host = "rtc.${var.domain}"
  repos    = ["gateway", "web", "slides", "computer"]
}

# ── Network: the default VPC, one security group ────────────────────────────

data "aws_vpc" "default" {
  default = true
}

data "aws_subnets" "default" {
  filter {
    name   = "vpc-id"
    values = [data.aws_vpc.default.id]
  }
  filter {
    name   = "availability-zone"
    values = ["${var.region}a"]
  }
}

resource "aws_security_group" "app" {
  name        = "sibyl-app"
  description = "Sibyl app: HTTPS, and LiveKit media when realtime is on. No SSH (use SSM)."
  vpc_id      = data.aws_vpc.default.id

  ingress {
    description = "HTTP (redirects to HTTPS, and Let's Encrypt challenges)"
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }
  ingress {
    description      = "HTTPS"
    from_port        = 443
    to_port          = 443
    protocol         = "tcp"
    cidr_blocks      = ["0.0.0.0/0"]
    ipv6_cidr_blocks = ["::/0"]
  }
  ingress {
    description = "HTTP/3"
    from_port   = 443
    to_port     = 443
    protocol    = "udp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  dynamic "ingress" {
    for_each = var.realtime ? [1] : []
    content {
      description = "LiveKit RTC over TCP"
      from_port   = 7881
      to_port     = 7881
      protocol    = "tcp"
      cidr_blocks = ["0.0.0.0/0"]
    }
  }
  dynamic "ingress" {
    for_each = var.realtime ? [1] : []
    content {
      description = "LiveKit RTC over UDP"
      from_port   = 7882
      to_port     = 7882
      protocol    = "udp"
      cidr_blocks = ["0.0.0.0/0"]
    }
  }

  egress {
    from_port        = 0
    to_port          = 0
    protocol         = "-1"
    cidr_blocks      = ["0.0.0.0/0"]
    ipv6_cidr_blocks = ["::/0"]
  }
}

# ── Instance role: SSM, ECR pull, its own parameters, SES sending ───────────

resource "aws_iam_role" "instance" {
  name = "sibyl-app-instance"
  assume_role_policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Principal = { Service = "ec2.amazonaws.com" }, Action = "sts:AssumeRole" }]
  })
}

resource "aws_iam_role_policy_attachment" "ssm" {
  role       = aws_iam_role.instance.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

resource "aws_iam_role_policy_attachment" "ecr" {
  role       = aws_iam_role.instance.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonEC2ContainerRegistryReadOnly"
}

resource "aws_iam_role_policy" "instance" {
  name = "sibyl-app"
  role = aws_iam_role.instance.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "ReadOwnSettings"
        Effect   = "Allow"
        Action   = ["ssm:GetParameter", "ssm:GetParameters", "ssm:GetParametersByPath"]
        Resource = "arn:aws:ssm:${var.region}:${data.aws_caller_identity.current.account_id}:parameter/sibyl/prod/*"
      },
      {
        Sid       = "SendMailAsDomain"
        Effect    = "Allow"
        Action    = ["ses:SendRawEmail", "ses:SendEmail"]
        Resource  = "*"
        Condition = { StringLike = { "ses:FromAddress" = "*@${var.domain}" } }
      }
    ]
  })
}

resource "aws_iam_instance_profile" "app" {
  name = "sibyl-app"
  role = aws_iam_role.instance.name
}

# ── Host ────────────────────────────────────────────────────────────────────

data "aws_ssm_parameter" "ubuntu" {
  name = "/aws/service/canonical/ubuntu/server/24.04/stable/current/amd64/hvm/ebs-gp3/ami-id"
}

resource "aws_instance" "app" {
  ami                    = data.aws_ssm_parameter.ubuntu.value
  instance_type          = var.instance_type
  subnet_id              = data.aws_subnets.default.ids[0]
  vpc_security_group_ids = [aws_security_group.app.id]
  iam_instance_profile   = aws_iam_instance_profile.app.name
  user_data              = file("${path.module}/cloud-init.yaml")
  monitoring             = true

  metadata_options {
    http_tokens                 = "required" # IMDSv2 only
    http_put_response_hop_limit = 1
  }

  root_block_device {
    volume_type = "gp3"
    volume_size = 40
    encrypted   = true
  }

  lifecycle {
    ignore_changes = [ami, user_data] # a new AMI or bootstrap script never replaces a running host
  }

  tags = { Name = "sibyl-app" }
}

# Data (sibyl.db, slides, recordings) on its own volume, so the host can be replaced.
resource "aws_ebs_volume" "data" {
  availability_zone = aws_instance.app.availability_zone
  size              = var.data_volume_gb
  type              = "gp3"
  encrypted         = true
  tags              = { Name = "sibyl-app-data", Backup = "daily" }
  lifecycle { prevent_destroy = true }
}

resource "aws_volume_attachment" "data" {
  device_name = "/dev/sdf"
  volume_id   = aws_ebs_volume.data.id
  instance_id = aws_instance.app.id
}

resource "aws_eip" "app" {
  domain   = "vpc"
  instance = aws_instance.app.id
  tags     = { Name = "sibyl-app" }
}

# ── Daily snapshots of the data volume, kept 14 days ────────────────────────

resource "aws_iam_role" "dlm" {
  name = "sibyl-app-snapshots"
  assume_role_policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Principal = { Service = "dlm.amazonaws.com" }, Action = "sts:AssumeRole" }]
  })
}

resource "aws_iam_role_policy_attachment" "dlm" {
  role       = aws_iam_role.dlm.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSDataLifecycleManagerServiceRole"
}

resource "aws_dlm_lifecycle_policy" "data" {
  description        = "Sibyl app data daily"
  execution_role_arn = aws_iam_role.dlm.arn
  state              = "ENABLED"
  policy_details {
    resource_types = ["VOLUME"]
    target_tags    = { Backup = "daily" }
    schedule {
      name = "daily"
      create_rule {
        interval      = 24
        interval_unit = "HOURS"
        times         = ["03:00"]
      }
      retain_rule { count = 14 }
      copy_tags = true
    }
  }
}

# ── Images ──────────────────────────────────────────────────────────────────

resource "aws_ecr_repository" "app" {
  for_each             = toset(local.repos)
  name                 = "sibyl/${each.key}"
  image_tag_mutability = "IMMUTABLE"
  image_scanning_configuration { scan_on_push = true }
  encryption_configuration { encryption_type = "AES256" }
}

resource "aws_ecr_lifecycle_policy" "app" {
  for_each   = aws_ecr_repository.app
  repository = each.value.name
  policy = jsonencode({
    rules = [{
      rulePriority = 1
      description  = "Keep the last 20 images"
      selection    = { tagStatus = "any", countType = "imageCountMoreThan", countNumber = 20 }
      action       = { type = "expire" }
    }]
  })
}

# ── Deploy role for GitHub Actions (OIDC, environment "app") ────────────────

data "aws_iam_openid_connect_provider" "github" {
  url = "https://token.actions.githubusercontent.com"
}

resource "aws_iam_role" "deploy" {
  name = "sibyl-app-deploy"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Federated = data.aws_iam_openid_connect_provider.github.arn }
      Action    = "sts:AssumeRoleWithWebIdentity"
      Condition = {
        StringEquals = {
          "token.actions.githubusercontent.com:aud" = "sts.amazonaws.com"
          "token.actions.githubusercontent.com:sub" = "repo:${var.github_repo}:environment:app"
        }
      }
    }]
  })
}

resource "aws_iam_role_policy" "deploy" {
  name = "build-and-deploy"
  role = aws_iam_role.deploy.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Effect = "Allow", Action = ["ecr:GetAuthorizationToken"], Resource = "*" },
      {
        Effect = "Allow"
        Action = [
          "ecr:BatchCheckLayerAvailability", "ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer",
          "ecr:InitiateLayerUpload", "ecr:UploadLayerPart", "ecr:CompleteLayerUpload", "ecr:PutImage", "ecr:DescribeImages"
        ]
        Resource = [for r in aws_ecr_repository.app : r.arn]
      },
      {
        Effect   = "Allow"
        Action   = ["ssm:SendCommand"]
        Resource = [aws_instance.app.arn, "arn:aws:ssm:${var.region}::document/AWS-RunShellScript"]
      },
      { Effect = "Allow", Action = ["ssm:GetCommandInvocation", "ssm:ListCommandInvocations"], Resource = "*" }
    ]
  })
}

# ── DNS at Hostinger ────────────────────────────────────────────────────────

resource "hostinger_dns_record" "app" {
  zone      = var.domain
  name      = "app"
  type      = "A"
  value     = aws_eip.app.public_ip
  ttl       = 300
  overwrite = true
}

resource "hostinger_dns_record" "rtc" {
  count     = var.realtime ? 1 : 0
  zone      = var.domain
  name      = "rtc"
  type      = "A"
  value     = aws_eip.app.public_ip
  ttl       = 300
  overwrite = true
}
