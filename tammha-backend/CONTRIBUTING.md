# Contributing to Tammha Backend

Thank you for contributing to the Tammha project! Please follow these guidelines to ensure consistency and quality.

## Code Style

### TypeScript & Naming Conventions
- Use **camelCase** for variables and functions
- Use **PascalCase** for classes and interfaces
- Use **UPPER_SNAKE_CASE** for constants
- Use **kebab-case** for file names (e.g., `user.controller.ts`)

### Module Structure
Each module should follow this structure:
```
src/modules/feature-name/
├── feature-name.module.ts
├── feature-name.controller.ts
├── feature-name.service.ts
├── dtos/
│   ├── create-feature.dto.ts
│   └── update-feature.dto.ts
└── entities/
    └── feature.entity.ts
```

### Code Quality
- **ESLint**: All code must pass linting
  ```bash
  npm run lint
  ```
- **Prettier**: Use consistent formatting
  ```bash
  npm run format
  ```
- **TypeScript Strict Mode**: No `any` types unless necessary
- **Error Handling**: Always handle errors gracefully

## Git Workflow

### Branch Naming
- Feature: `feature/feature-name`
- Bugfix: `bugfix/issue-name`
- Hotfix: `hotfix/urgent-fix`
- Chore: `chore/task-name`

### Commit Messages
```
type(scope): brief description

Detailed explanation (optional)

Closes #issue-number
```

Types: `feat`, `fix`, `docs`, `style`, `refactor`, `test`, `chore`

Example:
```
feat(auth): implement jwt token validation

Added JWT token validation middleware and guards
for protected routes.

Closes #123
```

### Pull Request Process
1. Create feature branch from `develop`
2. Implement changes with tests
3. Ensure all checks pass:
   ```bash
   npm run lint
   npm run format
   npm run test
   npm run build
   ```
4. Create PR with clear description
5. Request review from maintainers
6. Merge after approval

## Testing

### Unit Tests
```bash
npm run test
npm run test:watch
```

### E2E Tests
```bash
npm run test:e2e
```

### Coverage
```bash
npm run test:cov
```

Test files should be placed next to the module:
```
feature.service.ts
feature.service.spec.ts
```

## Database Changes

### Schema Updates
1. Update `prisma/schema.prisma`
2. Create migration:
   ```bash
   npm run prisma:migrate
   ```
3. Review generated migration file
4. Commit schema and migration files

### Writing Migrations
- Keep migrations focused and atomic
- Add comments explaining changes
- Always test migrations locally

## Documentation

### Code Comments
```typescript
/**
 * Find user by email and return profile
 * @param email - User email address
 * @returns User object or null if not found
 */
findByEmail(email: string): Promise<User | null>
```

### API Documentation
Use Swagger decorators for endpoints:
```typescript
@Post('register')
@ApiOperation({ summary: 'User registration' })
@ApiResponse({ status: 201, description: 'User created' })
@ApiResponse({ status: 400, description: 'Invalid input' })
create(@Body() dto: CreateUserDto) {
  return this.usersService.create(dto);
}
```

### README Updates
Update README.md when adding:
- New modules
- New environment variables
- New scripts
- Breaking changes

## Performance Considerations

### Database Queries
- Use `select` to limit fields
- Avoid N+1 queries with proper relationships
- Index frequently queried fields

### Caching
- Implement cache for frequently accessed data
- Invalidate cache on updates

### API Responses
- Paginate large result sets
- Return only necessary fields
- Use consistent response format

## Security

### Environment Variables
- Never commit `.env` files
- Use `.env.example` for templates
- Document all required variables

### Password & Secrets
- Use bcrypt for passwords (10+ rounds)
- Never log sensitive data
- Use strong JWT secrets (32+ chars)

### Input Validation
- Validate all user inputs
- Use class-validator decorators
- Sanitize database queries via ORM

## Release Process

### Version Bumping
Follow Semantic Versioning (MAJOR.MINOR.PATCH):
- `1.0.0` → `1.0.1` (patch - bug fixes)
- `1.0.0` → `1.1.0` (minor - new features)
- `1.0.0` → `2.0.0` (major - breaking changes)

### Changelog
Update CHANGELOG.md with:
- New features
- Bug fixes
- Breaking changes
- Dependencies updates

## Getting Help

- **Questions?** Check existing GitHub issues
- **Bug Report?** Create an issue with:
  - Environment details
  - Steps to reproduce
  - Expected vs actual behavior
- **Feature Request?** Describe the feature and its benefits

## Code Review Checklist

- [ ] Code follows style guidelines
- [ ] ESLint and Prettier checks pass
- [ ] Tests added/updated and passing
- [ ] Documentation updated
- [ ] No console.log statements
- [ ] Error handling implemented
- [ ] Input validation present
- [ ] No security vulnerabilities

---

Thank you for contributing to Tammha! 🎓
