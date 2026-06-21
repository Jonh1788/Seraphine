from seraphine.config import Settings


def test_email_urgency_defaults():
    s = Settings()
    assert s.email_urgency_enabled is True
    assert s.email_urgency_interval_s == 600
    assert s.email_urgency_quiet_start == "22:00"
    assert s.email_urgency_quiet_end == "07:00"
    assert s.owner_whatsapp_chat_id == "557388836445@c.us"
    assert s.app_public_url == "https://sera.jonhdev.io"
