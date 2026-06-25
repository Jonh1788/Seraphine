from seraphine.conversation.sentences import strip_markdown_for_tts


def test_anim_tag_stripped_when_audio_tags_kept():
    # v3 path: audio tags are LEFT in, but [anim:...] must still go.
    out = strip_markdown_for_tts("Oi [anim:acenar] tudo bem?", strip_audio_tags=False)
    assert "[anim:acenar]" not in out
    assert "anim" not in out
    assert "tudo bem" in out


def test_anim_tag_stripped_when_audio_tags_removed():
    out = strip_markdown_for_tts("Vamos [anim:comemorar] juntos", strip_audio_tags=True)
    assert "[anim:comemorar]" not in out
    assert "comemorar" not in out
    assert "juntos" in out
