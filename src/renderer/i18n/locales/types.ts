export type TranslationValue = string | ((params?: Record<string, string | number>) => string);
export type TranslationMap = Record<string, TranslationValue>;
