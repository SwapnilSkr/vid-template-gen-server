import eslint from "@eslint/js";
import tseslint from "typescript-eslint";
import globals from "globals";

export default [
  // Base ESLint recommended rules
  eslint.configs.recommended,

  // TypeScript ESLint recommended rules
  ...tseslint.configs.recommended,
  ...tseslint.configs.stylistic,

  // Global configuration
  {
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.es2021,
        Bun: "readonly",
      },
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },

  // TypeScript-specific rules
  {
    files: ["**/*.ts"],
    rules: {
      // ============================================
      // Code Quality & Hygiene
      // ============================================

      // Disallow unused variables (but allow unused args prefixed with _)
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],

      // Require explicit return types on functions
      "@typescript-eslint/explicit-function-return-type": "off",

      // Require explicit accessibility modifiers
      "@typescript-eslint/explicit-member-accessibility": "off",

      // Disallow explicit any type
      "@typescript-eslint/no-explicit-any": "warn",

      // Prefer const over let where possible
      "prefer-const": "error",

      // Disallow var
      "no-var": "error",

      // ============================================
      // Best Practices
      // ============================================

      // Require === and !== instead of == and !=
      eqeqeq: ["error", "always", { null: "ignore" }],

      // Disallow console.log in production (warn for now)
      "no-console": "off",

      // Disallow debugger statements
      "no-debugger": "error",

      // Disallow duplicate imports
      "no-duplicate-imports": "error",

      // ============================================
      // TypeScript Specific
      // ============================================

      // Allow non-null assertions (useful with Mongoose)
      "@typescript-eslint/no-non-null-assertion": "off",

      // Require consistent type imports
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { prefer: "type-imports", fixStyle: "inline-type-imports" },
      ],

      // Allow empty functions (useful for middleware stubs)
      "@typescript-eslint/no-empty-function": "off",

      // Prefer nullish coalescing
      "@typescript-eslint/prefer-nullish-coalescing": "off",

      // Prefer optional chaining
      "@typescript-eslint/prefer-optional-chain": "error",

      // ============================================
      // Stylistic (relaxed for flexibility)
      // ============================================

      // Allow empty interfaces (useful for extending)
      "@typescript-eslint/no-empty-interface": "off",
      "@typescript-eslint/no-empty-object-type": "off",

      // Consistent type definitions
      "@typescript-eslint/consistent-type-definitions": ["error", "interface"],
    },
  },

  // Ignore patterns
  {
    ignores: [
      "node_modules/**",
      "dist/**",
      "build/**",
      "*.js",
      "*.mjs",
      "processing/**",
    ],
  },
];
