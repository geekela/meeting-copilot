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


# --- Duplicate prevention ---------------------------------------------------

from app.tasks import task_key  # noqa: E402

CASUAL_NOTES = """ari takes care of booking venue
sam mentioned a nice vegan food restaurant
jules sends out invitations

mark says he would like to get drinks"""


def test_task_key_ignores_case_punctuation_and_articles():
    assert task_key("Book the venue.") == task_key("book venue") == task_key("  BOOK  a venue!")
    assert task_key("Book venue") != task_key("Book flights")


def test_analyze_marks_items_that_are_already_saved():
    first = client.post("/api/analyze", json={"notes": CASUAL_NOTES}).json()["action_items"]
    assert all(item["duplicate_of"] is None for item in first)

    saved = save(first[0], first[2])  # approve two of the four
    again = client.post("/api/analyze", json={"notes": CASUAL_NOTES}).json()["action_items"]
    assert [item["duplicate_of"] for item in again] == [saved[0]["id"], None, saved[1]["id"], None]


def test_duplicate_detection_survives_owner_and_wording_changes():
    task_id = save({**ARI, "task": "Book the venue."})[0]["id"]
    client.patch(f"/api/tasks/{task_id}", json={"owner": "Ariana"})
    items = client.post("/api/analyze", json={"notes": "Ari will book venue"}).json()["action_items"]
    assert items[0]["duplicate_of"] == task_id


def test_deleted_task_is_no_longer_a_duplicate():
    task_id = save({**ARI, "task": "Book venue"})[0]["id"]
    client.delete(f"/api/tasks/{task_id}")
    items = client.post("/api/analyze", json={"notes": "Ari will book venue"}).json()["action_items"]
    assert items[0]["duplicate_of"] is None


def test_repeated_lines_in_notes_appear_once():
    notes = "Ari will book venue\nAri will book the venue."
    items = client.post("/api/analyze", json={"notes": notes}).json()["action_items"]
    assert len(items) == 1


def test_saving_a_duplicate_returns_the_existing_task():
    original = save(ARI)[0]
    again = save({**ARI, "task": "book the venue", "owner": "Someone else"})
    assert again == [original]
    assert len(client.get("/api/tasks").json()) == 1


def test_duplicates_within_one_save_are_stored_once():
    result = save(ARI, {**ARI, "task": "Book the venue"}, SAM)
    assert result[0]["id"] == result[1]["id"] != result[2]["id"]
    assert len(client.get("/api/tasks").json()) == 2
