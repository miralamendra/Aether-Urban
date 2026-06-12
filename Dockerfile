FROM python:3.10-slim

# Set environment variables
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PORT=7860

WORKDIR /code

# Install system build dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

# Install python requirements
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Set up a new user with UID 1000 (standard for Hugging Face Spaces to run without root)
RUN useradd -m -u 1000 user
USER user
ENV HOME=/home/user \
    PATH=/home/user/.local/bin:$PATH

WORKDIR $HOME/app

# Copy project files and set ownership to the non-root user
COPY --chown=user . $HOME/app

# Expose default Hugging Face Space port
EXPOSE 7860

# Command to run the application
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "7860"]
