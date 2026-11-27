# Plain Terraform: resources become nodes, references between them become edges.
resource "aws_cloudfront_distribution" "site" {
  origin { domain_name = aws_s3_bucket.site.bucket_regional_domain_name }
  default_cache_behavior { target_origin_id = "api"  origin = aws_api_gateway_rest_api.api.id }
}

resource "aws_s3_bucket" "site" { bucket = "acme-site" }

resource "aws_api_gateway_rest_api" "api" {
  name = "acme-api"
  body = jsonencode({ handler = aws_lambda_function.orders.invoke_arn })
}

resource "aws_lambda_function" "orders" {
  function_name = "orders"
  role          = aws_iam_role.orders.arn
  environment {
    variables = {
      TABLE = aws_dynamodb_table.orders.name
      QUEUE = "${aws_sqs_queue.ship.url}"
    }
  }
}

resource "aws_iam_role" "orders" { name = "orders-lambda" }
resource "aws_dynamodb_table" "orders" { name = "orders"  hash_key = "id" }
resource "aws_sqs_queue" "ship" { name = "ship-requests" }

resource "aws_lambda_function" "shipper" {
  function_name = "shipper"
  role          = aws_iam_role.orders.arn
  source_queue  = aws_sqs_queue.ship.arn
  topic         = aws_sns_topic.shipped.arn
}

resource "aws_sns_topic" "shipped" { name = "shipped" }
