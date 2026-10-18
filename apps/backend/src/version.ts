/** App version; overridden at image build time via the APP_VERSION environment variable. */
export const APP_VERSION = process.env.APP_VERSION ?? '0.0.0-dev';
