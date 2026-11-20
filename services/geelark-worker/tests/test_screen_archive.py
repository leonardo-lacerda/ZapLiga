"""Arquivo de telas reais."""

from app.screen_archive import ScreenArchive, slug


def test_saves_each_screen_once_per_app_version(tmp_path):
    archive = ScreenArchive(str(tmp_path))
    shots = []
    shot = lambda: shots.append(1) or b"png"
    assert archive.save("whatsapp", "2.26.1.7", "escolher SMS/ligação", "abc", "<hierarchy/>", shot)
    assert not archive.save("whatsapp", "2.26.1.7", "escolher SMS/ligação", "abc", "<hierarchy/>", shot)
    assert archive.save("whatsapp", "2.26.2.1", "escolher SMS/ligação", "abc", "<hierarchy/>", shot)
    assert len(shots) == 2  # o print só é tirado para tela nova
    base = archive.path_for("whatsapp", "2.26.1.7", "escolher SMS/ligação", "abc")
    assert open(base + ".xml", encoding="utf-8").read() == "<hierarchy/>"
    assert open(base + ".png", "rb").read() == b"png"


def test_without_a_directory_nothing_is_saved():
    assert not ScreenArchive(None).save("whatsapp", "1", "x", "fp", "<h/>", lambda: b"")
    assert slug("Escolher SMS/ligação") == "escolher-sms-liga-o"
