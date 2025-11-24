# WebBots Dashboard

DFirst WebBots Dashboard for Deriv MT4/MT5 trading bots.

## Repository Structure

```
BotsLab/
├── index.html              # Main dashboard
├── oauth-callback.html     # OAuth callback handler
└── .github/
    └── workflows/
        └── deploy.yml      # GitHub Pages deployment workflow
```

## Deployment

This repository automatically deploys to GitHub Pages when changes are pushed to the `main` branch.

### First Time Setup

1. **Enable GitHub Pages:**
   - Go to repository Settings → Pages
   - Source: GitHub Actions
   - Save

2. **Push to Repository:**
   ```bash
   cd WebBots
   git remote add origin https://github.com/DFirst-App/BotsLab.git
   git push -u origin main
   ```

3. **Verify Deployment:**
   - Check Actions tab for deployment status
   - Once deployed, dashboard will be available at: `https://dfirst-app.github.io/BotsLab/`

## OAuth Configuration

To use OAuth, register the callback URL in Deriv App Settings:
- Go to https://developers.deriv.com/app-registration/
- Find your app (App ID: 67709)
- Add redirect URI: `https://[YOUR_DOMAIN]/oauth-callback.html`
- Or use your custom domain once configured

## Future Updates

All WebBots updates should be committed and pushed to this repository only:
```bash
cd WebBots
git add .
git commit -m "Your commit message"
git push origin main
```

