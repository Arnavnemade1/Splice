/**
 * Discord Webhook client for Splice Enterprise.
 * Routes high-fidelity security, forensics, and coordinator alerts.
 */
export class DiscordWebhook {
  private webhookUrl: string | undefined;

  constructor() {
    this.webhookUrl = process.env.DISCORD_WEBHOOK_URL;
  }

  /**
   * Set or update the webhook URL dynamically.
   */
  public setWebhookUrl(url: string) {
    this.webhookUrl = url;
  }

  /**
   * Check if the webhook client is active and configured.
   */
  public isActive(): boolean {
    // Discord webhook integration is currently put on hold by user request.
    return false;
  }

  /**
   * Send a rich embed message to Discord.
   * Fails silently (logs to console.error) to ensure security checks never crash the agent.
   */
  public async sendEmbed(params: {
    title: string;
    description: string;
    fields?: Array<{ name: string; value: string; inline?: boolean }>;
    color?: number; // Integer representation of hex, e.g. 0xe74c3c
    url?: string;
    footerText?: string;
  }): Promise<boolean> {
    if (!this.webhookUrl) {
      return false;
    }

    try {
      const embed: any = {
        title: params.title,
        description: params.description,
        timestamp: new Date().toISOString(),
        color: params.color ?? 0x3498db, // Default blue
      };

      if (params.fields && params.fields.length > 0) {
        embed.fields = params.fields.map(f => ({
          name: f.name,
          value: f.value.length > 1024 ? f.value.substring(0, 1021) + "..." : f.value,
          inline: f.inline ?? false,
        }));
      }

      if (params.url) {
        embed.url = params.url;
      }

      if (params.footerText) {
        embed.footer = { text: params.footerText };
      } else {
        embed.footer = { text: "Splice Autonomous Security Hub" };
      }

      const payload = {
        username: "Splice Enterprise Agent",
        avatar_url: "https://raw.githubusercontent.com/Arnavnemade1/Splice/main/assets/splice-logo.png", // Fallback if logo available
        embeds: [embed],
      };

      const response = await fetch(this.webhookUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        console.error(`[Discord Webhook] Failed to send update. Status: ${response.status} ${response.statusText}`);
        return false;
      }

      return true;
    } catch (e: any) {
      console.error(`[Discord Webhook] Error sending message: ${e.message}`);
      return false;
    }
  }

  /**
   * Sends a quick text notification message without embeds.
   */
  public async sendText(text: string): Promise<boolean> {
    if (!this.webhookUrl) {
      return false;
    }

    try {
      const response = await fetch(this.webhookUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ content: text, username: "Splice Enterprise Agent" }),
      });

      return response.ok;
    } catch (e: any) {
      console.error(`[Discord Webhook] Error sending text message: ${e.message}`);
      return false;
    }
  }
}

export const discordNotifier = new DiscordWebhook();
