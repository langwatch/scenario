# Testing Guide for @langwatch/scenario-ts

This document outlines the testing approach, conventions, and best practices for the @langwatch/scenario-ts library.

## Test Structure

Tests are organized by module:

- `src/__tests__/scenario`: Tests for core components like `Scenario`
- `src/__tests__/testing-agent`: Tests for the `ScenarioTestingAgent` and related components
- `src/__tests__/conversation`: Tests for the conversation runner and related utilities
- `src/__tests__/shared`: Tests for shared utilities and helper functions

Each test file is collocated with the code it tests in a `__tests__` directory.

## Running Tests

Tests can be run using the following command:

```bash
pnpm test
```

This command runs Vitest in run mode. For development with watch mode:

```bash
pnpm test -- --watch
```

## Testing Guidelines

1. **Test file naming**: Use `.test.ts` suffix for all test files
2. **Test coverage**: Aim for high coverage of core functionality
3. **Test isolation**: Each test should be independent and not rely on state from other tests
4. **Use beforeEach for setup**: Reset mocks and create fresh instances before each test
5. **Clear mocks between tests**: Use `vi.clearAllMocks()` in `beforeEach` to ensure clean state

## Mocking Strategy

We use Vitest for mocking:

- Use `vi.mock()` to mock dependencies
- Define mock implementations inline within the mock setup
- Import mocked modules **after** defining the mocks to avoid hoisting issues
- For complex mocks, define mock implementation constants at the top level
- Prefer direct mocking over trying to spy on imported functions
- Use `vi.mocked()` for proper TypeScript typings when accessing mock functions

## Example Test Structure

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import { ComponentToTest } from "../ComponentToTest";

// 1. Setup mocks
vi.mock("../dependency", () => ({
  dependencyFunction: vi.fn(),
}));

// 2. Import mocked modules AFTER mocking
import { dependencyFunction } from "../dependency";

describe("ComponentToTest", () => {
  let component: ComponentToTest;

  // 3. Setup fresh state before each test
  beforeEach(() => {
    vi.clearAllMocks();
    component = new ComponentToTest();
  });

  // 4. Test cases
  it("should do something", () => {
    // Arrange
    vi.mocked(dependencyFunction).mockReturnValue("mocked result");

    // Act
    const result = component.doSomething();

    // Assert
    expect(result).toBe("expected result");
    expect(dependencyFunction).toHaveBeenCalledWith("expected args");
  });
});
```

## Testing Async Code

When testing asynchronous functions, always use `async/await`:

```typescript
it("should handle async operations", async () => {
  // Arrange
  vi.mocked(asyncDependency).mockResolvedValue("mocked result");

  // Act
  const result = await component.doAsyncStuff();

  // Assert
  expect(result).toBe("expected result");
});
```

## Integration Testing

Integration tests that demonstrate the complete flow of the library can be found in the `examples/vitest` directory. These examples also serve as documentation for how to use the library.

### Running Integration Tests

To run integration tests, you need to:

1. First build and package the library:

   ```bash
   pnpm run build      # Build the library
   pnpm run buildpack  # Package it as a .tgz file
   ```

2. Then run the example tests:
   ```bash
   pnpm run examples:vitest:run test
   ```

The `buildpack` step is essential because the examples use the locally packaged version of the library. This workflow ensures that:

- You're testing against the exact package that would be published to npm
- The integration tests use the library exactly as an end user would
- Any issues with packaging or exports are caught early

If you make changes to the library code, you'll need to rebuild and repackage before running the example tests again.

## Troubleshooting Common Issues

1. **Mocking Issues**: If you receive "Cannot access X before initialization", make sure you're importing the mocked modules after calling `vi.mock()`.

2. **Type Errors with Mocks**: Use `vi.mocked()` to ensure proper TypeScript typings for your mocks:

   ```typescript
   const mockedFunction = vi.mocked(myFunction);
   mockedFunction.mockReturnValue("test");
   ```

3. **Clearing Mocks**: Always clear mocks between tests using `vi.clearAllMocks()` in `beforeEach` hooks to avoid test interdependencies.
