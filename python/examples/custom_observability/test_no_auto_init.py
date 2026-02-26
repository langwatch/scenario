"""Test: Verify that importing scenario does not auto-init OTel."""
import os

# Ensure no LangWatch data is sent
os.environ["LANGWATCH_API_KEY"] = ""


def main():
    from opentelemetry import trace
    from opentelemetry.sdk.trace import TracerProvider

    # Check the provider BEFORE importing scenario
    provider_before = trace.get_tracer_provider()
    print(f"Provider before import: {type(provider_before).__name__}")

    # Import scenario
    import scenario  # noqa: F401

    # Check after import
    provider_after = trace.get_tracer_provider()
    print(f"Provider after import: {type(provider_after).__name__}")

    # Verify no TracerProvider was set
    is_sdk_provider = isinstance(provider_after, TracerProvider)
    print(f"Is SDK TracerProvider: {is_sdk_provider}")

    if is_sdk_provider:
        print("\nFAIL: Importing scenario auto-initialized OTel")
        exit(1)

    print("\nPASS: No auto-initialization on import")
    exit(0)


if __name__ == "__main__":
    main()
