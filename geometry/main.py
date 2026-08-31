import uvicorn

if __name__ == "__main__":
    uvicorn.run(
        "api:app",
        host="0.0.0.0",
        port=8000,
        reload=True,  # Enable automatic reload in development mode.
        timeout_keep_alive=2000,  # Large-area processing may exceed the default five-second timeout.
    )
