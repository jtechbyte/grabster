import requests

BASE_URL = "http://127.0.0.1:8001"

# Login first to get cookies
session = requests.Session()
login_res = session.post(f"{BASE_URL}/token", data={"username": "admin", "password": "admin123"})
print(f"Login status: {login_res.status_code}")

if login_res.status_code == 200:
    token = login_res.json()["access_token"]
    print(f"Token received: {token[:20]}...")
    
    # Set cookie
    session.cookies.set("access_token", token)
    
    # Test GET /api/queue
    print("\n--- Testing GET /api/queue ---")
    queue_res = session.get(f"{BASE_URL}/api/queue")
    print(f"Status: {queue_res.status_code}")
    print(f"Response: {queue_res.text[:200]}")
    
    # Test POST /api/system/clear-queue
    print("\n--- Testing POST /api/system/clear-queue ---")
    clear_res = session.post(f"{BASE_URL}/api/system/clear-queue")
    print(f"Status: {clear_res.status_code}")
    print(f"Response: {clear_res.text}")
    
    # Check server logs for [CLEAR_QUEUE] message
    print("\n--- Check server terminal for [CLEAR_QUEUE] debug messages ---")
