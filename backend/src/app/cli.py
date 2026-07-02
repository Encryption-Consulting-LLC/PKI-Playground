import uvicorn

from app.celery_app import celery_app


def main() -> None:
    uvicorn.run("app.main:app", reload=True)


def worker() -> None:
    celery_app.worker_main(
        argv=["worker", "-E", "--concurrency=2", "--prefetch-multiplier=1"]
    )
