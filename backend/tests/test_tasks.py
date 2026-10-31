from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)

ARI = {"task": "Book venue", "owner": "Ari", "deadline": "No deadline", "kind": "commitment"}
SAM = {"task": "Consider the vegan restaurant", "owner": "Sam", "kind": "suggestion"}


def save(*tasks):
    res = client.post("/api/tasks", json={"tasks": list(tasks)})
    assert res.status_code == 201, res.text
    return res.json()


def test_starts_empty():
    assert client.get("/api/tasks").json() == []


def test_save_and_list_tasks():
    saved = save(ARI, SAM)
    assert [t["task"] for t in saved] == ["Book venue", "Consider the vegan restaurant"]
    first = saved[0]
    assert set(first) == {"id", "task", "owner", "deadline", "kind", "completed", "created_at"}
    assert first["completed"] is False
    assert saved[1]["deadline"] == "No deadline"  # default applied
    assert client.get("/api/tasks").json() == saved


def test_tasks_persist_across_clients():
    save(ARI)
    assert len(TestClient(app).get("/api/tasks").json()) == 1


def test_update_owner_and_completed():
    task_id = save(ARI)[0]["id"]
    res = client.patch(f"/api/tasks/{task_id}", json={"owner": "Carla", "completed": True})
    assert res.status_code == 200
    assert res.json()["owner"] == "Carla" and res.json()["completed"] is True

    # Partial update leaves other fields alone.
    res = client.patch(f"/api/tasks/{task_id}", json={"completed": False})
    assert res.json()["owner"] == "Carla" and res.json()["completed"] is False


def test_update_deadline():
    task_id = save(ARI)[0]["id"]
    res = client.patch(f"/api/tasks/{task_id}", json={"deadline": "next Friday"})
    assert res.status_code == 200
    assert res.json()["deadline"] == "next Friday" and res.json()["owner"] == "Ari"
    assert client.get("/api/tasks").json()[0]["deadline"] == "next Friday"


def test_update_ignores_fields_that_cannot_change():
    task_id = save(ARI)[0]["id"]
    res = client.patch(f"/api/tasks/{task_id}", json={"task": "Hacked", "id": 999})
    assert res.status_code == 200
    assert res.json()["task"] == "Book venue" and res.json()["id"] == task_id


def test_delete_task():
    a, b = save(ARI, SAM)
    assert client.delete(f"/api/tasks/{a['id']}").status_code == 204
    assert [t["id"] for t in client.get("/api/tasks").json()] == [b["id"]]


def test_missing_task_returns_404():
    assert client.patch("/api/tasks/12345", json={"completed": True}).status_code == 404
    assert client.delete("/api/tasks/12345").status_code == 404


def test_invalid_payloads_rejected():
    assert client.post("/api/tasks", json={"tasks": []}).status_code == 422
    assert client.post("/api/tasks", json={"tasks": [{"task": ""}]}).status_code == 422
    assert client.post("/api/tasks", json={"tasks": [{**ARI, "kind": "other"}]}).status_code == 422
    assert client.get("/api/tasks").json() == []  # nothing partially saved


def test_injection_text_is_stored_verbatim():
    evil = {**ARI, "task": "x'); DROP TABLE tasks; --"}
    save(evil)
    assert client.get("/api/tasks").json()[0]["task"] == evil["task"]


def test_many_requests_in_a_row_all_succeed():
    # Regression: the connection is created and used on different threads.
    ids = [save({**ARI, "task": f"Task {i}"})[0]["id"] for i in range(15)]
    for task_id in ids:
        assert client.patch(f"/api/tasks/{task_id}", json={"completed": True}).status_code == 200
    for task_id in ids:
        assert client.delete(f"/api/tasks/{task_id}").status_code == 204
    assert client.get("/api/tasks").json() == []
