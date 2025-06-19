# Contributing to @langwatch/scenario-ts

Thank you for your interest in contributing to @langwatch/scenario-ts! This document provides guidelines and instructions for contributing to this project.

## Code of Conduct

Please be respectful and considerate of others when contributing to this project. We strive to maintain a welcoming and inclusive environment for everyone.

## Getting Started

### Prerequisites

- Node.js (v18 or higher)
- pnpm (v8 or higher)

### Setup

1. Fork the repository on GitHub
2. Clone your fork locally
   ```bash
   git clone https://github.com/YOUR-USERNAME/scenario-ts.git
   cd scenario-ts
   ```
3. Install dependencies
   ```bash
   pnpm install
   ```
4. Create a branch for your changes
   ```bash
   git checkout -b feature/your-feature-name
   ```

## Development Workflow

### Building the Project

```bash
pnpm run build
```

This will compile the TypeScript code to both CommonJS and ESM formats.

### Running Tests

```bash
pnpm test
```

### Linting and Formatting

```bash
# Run linter
pnpm run lint

# Format code
pnpm run format
```

## Project Rules

Always follow these important rules:

- Always use pnpm for package management (never npm or yarn)
- Package is published as @langwatch/scenario-ts
- Build outputs for both CommonJS and ESM
- Examples must use @langwatch/scenario-ts import
- Keep dist/ in .gitignore

## Making Changes

1. Make your changes following the [Style Guide](./STYLE_GUIDE.md)
2. Write or update tests for your changes
3. Ensure all tests pass
4. Commit your changes with a clear commit message
5. Push to your fork
6. Submit a pull request

### Commit Message Guidelines

- Use the present tense ("Add feature" not "Added feature")
- Use the imperative mood ("Move cursor to..." not "Moves cursor to...")
- Reference issues and pull requests liberally after the first line
- Consider starting the commit message with an applicable prefix:
  - `feat:` for new features
  - `fix:` for bug fixes
  - `docs:` for documentation changes
  - `style:` for formatting changes
  - `refactor:` for code refactoring
  - `test:` for adding or updating tests
  - `chore:` for maintenance tasks

## Pull Request Process

1. Update the README.md or documentation with details of changes if appropriate
2. Update the version numbers in package.json and elsewhere following [Semantic Versioning](https://semver.org/)
3. Your pull request will be reviewed by maintainers, who may request changes
4. Once approved, your pull request will be merged

## Release Process

Releases are handled by the maintainers. We follow Semantic Versioning:

- MAJOR version for incompatible API changes
- MINOR version for backwards-compatible functionality additions
- PATCH version for backwards-compatible bug fixes

## Questions?

If you have any questions about contributing, please open an issue or reach out to the maintainers.
