declare namespace Cloudflare {
  interface Env {
    DB?: D1Database;
    BUCKET?: R2Bucket;
    ICE_SERVERS_JSON?: string;
    CLOUDFLARE_TURN_KEY_ID?: string;
    CLOUDFLARE_TURN_API_TOKEN?: string;
  }
}
