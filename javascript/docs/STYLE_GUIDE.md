# Style Guide

This document outlines the coding standards and file structure patterns for the @langwatch/scenario-ts project.

## Code Style

### TypeScript

- Use TypeScript for all code
- Enable strict type checking
- Provide explicit type annotations for public APIs
- Use interfaces for public API contracts
- Use JSDoc comments for all public APIs

### Naming Conventions

- **Files**: Use `kebab-case.ts` for filenames
- **Classes**: Use `PascalCase` for class names
- **Interfaces**: Use `PascalCase` for interface names
- **Functions and Methods**: Use `camelCase` for function and method names
- **Constants**: Use `UPPER_SNAKE_CASE` for constants that are truly immutable
- **Variables**: Use `camelCase` for variable names
- **Private Properties**: Use `_camelCase` for private properties

### Code Organization

- Organize code by feature, not by type
- Each class should be in its own file
- Group related functionality into feature directories
- Use a `shared` directory for code shared across features
- Create index files (barrel exports) for each feature directory
- Use relative imports within a feature, import from barrels across features

#### Barrel Exports

Each feature directory should have an `index.ts` file that re-exports public components:

```typescript
// src/feature/index.ts
export * from "./feature-component";
export * from "./feature-service";
// Do not export private implementation details
```

This allows consumers to import all related functionality from one path:

```typescript
// Good
import { FeatureComponent, FeatureService } from "./feature";

// Avoid
import { FeatureComponent } from "./feature/feature-component";
import { FeatureService } from "./feature/feature-service";
```

## File Structure

```
scenario-ts/
├── dist/                 # Compiled output (not in git)
├── docs/                 # Documentation files
├── examples/             # Example usage scenarios
│   ├── basic/            # Basic usage examples
│   └── vitest/           # Vitest integration examples
├── src/                  # Source code
│   ├── conversation/     # Conversation feature
│   │   ├── index.ts      # Barrel exports for conversation
│   │   └── runner.ts     # Conversation runner implementation
│   ├── shared/           # Shared utilities across features
│   │   ├── index.ts      # Barrel exports for shared code
│   │   ├── types/        # Shared type definitions
│   │   │   └── index.ts  # Barrel exports for types
│   │   └── utils/        # Shared utility functions
│   │       └── index.ts  # Barrel exports for utils
│   ├── testing-agent/    # Testing agent feature
│   │   ├── index.ts      # Barrel exports for testing agent
│   │   ├── agent.ts      # Testing agent implementation
│   │   └── tools/        # Testing agent tools
│   │       └── index.ts  # Barrel exports for tools
│   ├── Scenario.ts       # Main Scenario class
│   └── index.ts          # Main public API exports
├── tests/                # Unit and integration tests
├── package.json          # Package configuration
├── tsconfig.json         # TypeScript configuration
└── README.md             # Project documentation
```

## Feature-Based Architecture

This project follows a feature-based architecture:

1. **Features**: Each major feature has its own directory

   - Examples: `conversation`, `testing-agent`
   - Files within a feature directory should only implement that feature
   - Each feature should expose a clean public API through its index file

2. **Shared Code**: Code used across features goes in the `shared` directory

   - Shared types, utilities, and constants
   - Shared services and interfaces
   - Careful consideration before adding to shared (is it really shared?)

3. **Feature Isolation**: Features should be as isolated as possible
   - Minimize dependencies between features
   - Dependencies should flow in one direction where possible (avoid circular dependencies)
   - Features communicate through well-defined interfaces

## Principles

### Single Responsibility

Each class and module should have a single responsibility. If a class or module is doing too many things, split it into smaller, more focused units.

### Interfaces for Contracts

Use interfaces to define contracts between components. This makes it easier to mock and test components in isolation.

### Explicit Public API

Be explicit about what is part of the public API. Only export what needs to be used by consumers of the library.

### Error Handling

- Be explicit about error handling
- Use typed errors where possible
- Provide helpful error messages

### Testing

- Write tests for all public API functionality
- Use vitest for testing
- Aim for high test coverage of core functionality

## Formatting and Linting

We use the following tools for code quality:

- ESLint for linting
- Prettier for code formatting
- TypeScript strict mode for type checking

Run these tools regularly:

```bash
# Format code
pnpm run format

# Lint code
pnpm run lint

# Type check
pnpm run type-check
```

## Documentation

- Document all public APIs with JSDoc comments
- Keep the README up to date
- Document architectural decisions in ADRs
- Include examples for complex functionality
