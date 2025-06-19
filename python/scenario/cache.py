"""
Caching module for deterministic scenario testing.

This module provides caching functionality to make scenario tests deterministic
and repeatable. It caches LLM calls and other non-deterministic operations based
on scenario configuration and function arguments, enabling consistent test results
across multiple runs.
"""

from contextvars import ContextVar
import inspect
import os
from pathlib import Path
from typing import Callable, TYPE_CHECKING
from joblib import Memory

import json

import wrapt
from scenario.types import AgentInput
from scenario._utils.utils import SerializableWithStringFallback

if TYPE_CHECKING:
    from scenario.scenario_executor import ScenarioExecutor


context_scenario = ContextVar("scenario")


def get_cache() -> Memory:
    """
    Get a cross-platform cache directory for scenario execution.

    Creates and returns a joblib Memory instance configured to use a
    cross-platform cache directory. The cache location can be customized
    via the SCENARIO_CACHE_DIR environment variable.

    Returns:
        Memory instance configured with the appropriate cache directory

    Example:
        ```
        # Default cache location: ~/.scenario/cache
        cache = get_cache()

        # Custom cache location via environment variable
        os.environ["SCENARIO_CACHE_DIR"] = "/tmp/my_scenario_cache"
        cache = get_cache()
        ```
    """
    home_dir = str(Path.home())
    cache_dir = os.path.join(home_dir, ".scenario", "cache")

    return Memory(location=os.environ.get("SCENARIO_CACHE_DIR", cache_dir), verbose=0)


memory = get_cache()


def scenario_cache(ignore=[]):
    """
    Decorator for caching function calls during scenario execution.

    This decorator caches function calls based on the scenario's cache_key,
    scenario configuration, and function arguments. It enables deterministic
    testing by ensuring the same inputs always produce the same outputs,
    making tests repeatable and faster on subsequent runs.

    Args:
        ignore: List of argument names to exclude from the cache key computation.
                Commonly used to ignore 'self' for instance methods or other
                non-deterministic arguments.

    Returns:
        Decorator function that can be applied to any function or method

    Example:
        ```
        import scenario

        class MyAgent:
            @scenario.cache(ignore=["self"])
            def invoke(self, message: str, context: dict) -> str:
                # This LLM call will be cached
                response = llm_client.complete(
                    model="gpt-4",
                    messages=[{"role": "user", "content": message}]
                )
                return response.choices[0].message.content

        # Usage in tests
        scenario.configure(cache_key="my-test-suite-v1")

        # First run: makes actual LLM calls and caches results
        result1 = await scenario.run(...)

        # Second run: uses cached results, much faster
        result2 = await scenario.run(...)
        # result1 and result2 will be identical
        ```

    Note:
        - Caching only occurs when a cache_key is set in the scenario configuration
        - The cache key is computed from scenario config, function arguments, and cache_key
        - AgentInput objects are specially handled to exclude thread_id from caching
        - Both sync and async functions are supported
    """

    @wrapt.decorator
    def wrapper(wrapped: Callable, instance=None, args=[], kwargs={}):
        scenario: "ScenarioExecutor" = context_scenario.get()

        if not scenario.config.cache_key:
            return wrapped(*args, **kwargs)

        sig = inspect.signature(wrapped)
        parameters = list(sig.parameters.values())

        all_args = {
            str(parameter.name): value for parameter, value in zip(parameters, args)
        }
        for arg in ["self"] + ignore:
            if arg in all_args:
                del all_args[arg]

        for key, value in all_args.items():
            if isinstance(value, AgentInput):
                scenario_state = value.scenario_state.model_dump(exclude={"thread_id"})
                all_args[key] = value.model_dump(exclude={"thread_id"})
                all_args[key]["scenario_state"] = scenario_state

        cache_key = json.dumps(
            {
                "cache_key": scenario.config.cache_key,
                "scenario": scenario.config.model_dump(exclude={"agents"}),
                "all_args": all_args,
            },
            cls=SerializableWithStringFallback,
        )

        # if is an async function, we need to wrap it in a sync function
        if inspect.iscoroutinefunction(wrapped):
            return _async_cached_call(wrapped, args, kwargs, cache_key=cache_key)
        else:
            return _cached_call(wrapped, args, kwargs, cache_key=cache_key)

    return wrapper


@memory.cache(ignore=["func", "args", "kwargs"])
def _cached_call(func: Callable, args, kwargs, cache_key):
    """
    Internal function for caching synchronous function calls.

    This function is used internally by the scenario_cache decorator
    to cache synchronous function calls using joblib.Memory.

    Args:
        func: The function to call and cache
        args: Positional arguments for the function
        kwargs: Keyword arguments for the function
        cache_key: Cache key for deterministic caching

    Returns:
        The result of calling func(*args, **kwargs)
    """
    return func(*args, **kwargs)


@memory.cache(ignore=["func", "args", "kwargs"])
async def _async_cached_call(func: Callable, args, kwargs, cache_key):
    """
    Internal function for caching asynchronous function calls.

    This function is used internally by the scenario_cache decorator
    to cache asynchronous function calls using joblib.Memory.

    Args:
        func: The async function to call and cache
        args: Positional arguments for the function
        kwargs: Keyword arguments for the function
        cache_key: Cache key for deterministic caching

    Returns:
        The result of calling await func(*args, **kwargs)
    """
    return await func(*args, **kwargs)
