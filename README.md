# Zappie 🟣

> Ta boîte mail, enfin zéro stress.

## Installation

### 1. Installe les dépendances
```bash
npm install
```

### 2. Configure les variables d'environnement
```bash
cp .env.example .env
```
Ouvre le fichier `.env` et remplis :
- `GOOGLE_CLIENT_ID` → depuis Google Cloud Console
- `GOOGLE_CLIENT_SECRET` → depuis Google Cloud Console
- `ANTHROPIC_API_KEY` → depuis console.anthropic.com
- `SESSION_SECRET` → n'importe quel texte long aléatoire

### 3. Configure Google Cloud
1. Va sur https://console.cloud.google.com
2. Crée un projet "Zappie"
3. Active l'API Gmail
4. Crée des identifiants OAuth 2.0 (Application Web)
5. Ajoute `http://localhost:3000/auth/callback` comme URI de redirection autorisée
6. Copie le Client ID et Client Secret dans ton `.env`

### 4. Lance le serveur
```bash
npm start
```

### 5. Ouvre dans ton navigateur
```
http://localhost:3000
```

## Fonctionnalités

- ✅ Connexion Gmail via Google OAuth
- 🧠 Analyse IA de chaque email (Claude)
- 📁 Rangement automatique dans un dossier "Zappie"
- ↩️ Restauration en 1 clic
- 📊 Dashboard avec statistiques

## Comment ça marche

1. Tu connectes ton Gmail
2. Tu cliques "Analyser mes emails"
3. L'IA lit les 20 derniers emails non lus
4. Les emails inutiles (newsletters, spams, promos) vont dans le dossier "Zappie"
5. Les emails importants restent dans ta boîte principale
6. Tu peux restaurer n'importe quel email en 1 clic
