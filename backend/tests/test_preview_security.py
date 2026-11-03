from app.config import Settings
from app.main import create_app
from fastapi.testclient import TestClient


def test_app_documents_block_frame_navigation_without_enabling_file_scripts(tmp_path):
    frontend = tmp_path / "frontend"
    frontend.mkdir()
    (frontend / "index.html").write_text("<!doctype html><html><body>app</body></html>")
    app = create_app(Settings(data_dir=tmp_path / "data", frontend_dist=frontend, sandbox_backend="disabled"))
    with TestClient(app) as client:
        for path in ("/", "/conversation/example"):
            response = client.get(path)
            assert response.status_code == 200
            assert response.headers["content-security-policy"] == "frame-src 'none'; object-src 'none'"
        assert "content-security-policy" not in client.get("/api/auth/me").headers
