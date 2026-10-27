import tseslint from 'typescript-eslint'
import hooks from 'eslint-plugin-react-hooks'
export default tseslint.config(
  { ignores: ['node_modules/**', 'out/**', 'release/**', 'dist/**', 'src/renderer/public/pdfjs/**', 'test-results/**', 'playwright-report/**', '项目管理/**'] },
  ...tseslint.configs.recommended,
  { files: ['**/*.{ts,tsx}'], rules: { '@typescript-eslint/no-explicit-any': 'error' } },
  { files: ['src/renderer/src/**/*.{ts,tsx}'], plugins: { 'react-hooks': hooks },
    rules: { 'react-hooks/rules-of-hooks': 'error', 'react-hooks/exhaustive-deps': 'warn' } }
)
