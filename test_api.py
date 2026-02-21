
import requests
import time

BASE_URL = "http://127.0.0.1:8001"

def login():
    print("--- Logging in ---")
    try:
        res = requests.post(f"{BASE_URL}/token", data={"username": "admin", "password": "admin123"})
        if res.status_code == 200:
            token = res.json()["access_token"]
            print(f"Login success. Token: {token[:10]}...")
            return {"Authorization": f"Bearer {token}"}
        else:
            print(f"Login failed: {res.text}")
            return None
    except Exception as e:
        print(f"Login Error: {e}")
        return None

def test_queue(headers):
    print("--- Fetching Queue ---")
    try:
        res = requests.get(f"{BASE_URL}/api/queue", headers=headers)
        if res.status_code != 200:
            print(f"Error: {res.status_code} {res.text}")
            return

        jobs = res.json()
        print(f"Jobs Count: {len(jobs)}")
        for j in jobs:
            print(f" - {j['id'][:8]} | {j['status']} | InLib:{j.get('is_in_library')} | InDL:{j.get('is_in_downloads')}")
    except Exception as e:
        print(f"Error: {e}")

def test_clear(headers):
    print("\n--- Clearing Queue (API) ---")
    try:
        res = requests.post(f"{BASE_URL}/api/system/clear-queue", headers=headers)
        print(f"Status: {res.status_code}")
        print(f"Response: {res.json()}")
    except Exception as e:
        print(f"Error: {e}")

if __name__ == "__main__":
    headers = login()
    if headers:
        test_queue(headers)
        test_clear(headers)
        time.sleep(1)
        test_queue(headers)
