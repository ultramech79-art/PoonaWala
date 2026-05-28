from google import genai

client = genai.Client(vertexai=True, project="poonawala-497707", location="global")

try:
    response = client.models.generate_content(
        model="gemini-3.5-flash",
        contents=["hello"]
    )
    print("3.5-flash global worked:", response.text)
except Exception as e:
    print("3.5-flash global failed:", e)