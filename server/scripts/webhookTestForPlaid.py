# fire a DEFAULT_UPDATE webhook for an item
request = SandboxItemFireWebhookRequest(
  access_token=access_token,
  webhook_code='DEFAULT_UPDATE'
)
response = client.sandbox_item_fire_webhook(request)
