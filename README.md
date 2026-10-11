# LUCY // Neural Interface

Application de bureau autonome pour Arch Linux et Hyprland. Le chat et les réponses en flux SSE sont envoyés directement à un fournisseur compatible OpenAI ; le serveur OpenCode n’est pas nécessaire pour discuter.

## Installation sur Arch Linux

Installe les dépendances de compilation et bibliothèques graphiques :

```sh
sudo pacman -S --needed base-devel webkit2gtk-4.1 gtk3 libayatana-appindicator librsvg patchelf nodejs npm rustup
rustup default stable
```

Depuis le dossier du projet, installe les paquets JavaScript et démarre l’application :

```sh
npm install
npm run tauri dev
```

Pour créer le binaire de production :

```sh
npm run tauri build
install -Dm755 src-tauri/target/release/lucy "$HOME/.local/bin/lucy"
install -Dm644 lucy.desktop "$HOME/.local/share/applications/lucy.desktop"
install -Dm644 src-tauri/icons/icon.png "$HOME/.local/share/icons/hicolor/256x256/apps/lucy.png"
lucy
```

Au premier lancement, LUCY importe automatiquement les comptes OpenCode déjà présents lorsque son stockage local ne contient encore aucun fournisseur. Les comptes OpenCode déjà importés sont resynchronisés en arrière-plan aux lancements suivants, afin d’ajouter les nouvelles connexions. Les clés API OpenCode de type `key` (par exemple Google et Groq) ainsi que les connexions OAuth prises en charge sont importées. En cas d’échec de catalogue, le compte reste enregistré et l’interface affiche l’erreur avec une action pour réessayer. Le modèle actuellement sélectionné est conservé localement et restauré au prochain lancement. Si `~/.local/bin` n'est pas déjà dans ton `PATH`, ajoute-le à la configuration de ton shell.

## Fournisseurs et modèles

Dans **Fournisseurs & modèles**, tu peux importer les identifiants OpenCode compatibles disponibles via `opencode auth export`, ou enregistrer une URL d’API compatible OpenAI et une clé. Pour Ollama, utilise généralement `http://127.0.0.1:11434/v1` et laisse la clé vide. Actualise ensuite la liste des modèles et sélectionne le modèle souhaité.

Les identifiants LUCY sont stockés dans son dossier de configuration local avec des permissions Unix `0600`. Les requêtes partent directement de LUCY vers l’URL configurée. Les comptes propriétaires qui ne fournissent pas une API compatible ne peuvent pas être importés ; le renouvellement automatique du jeton OAuth GitHub Copilot n’est pas pris en charge.

## Capacités disponibles

- Conversations locales, sélection de fournisseur/modèle et conservation de l’historique.
- Au lancement, ouverture directe de `/home/Matthew` et création d’une nouvelle session. Le dossier de projet reste modifiable depuis la barre latérale.
- Sélecteur de modèle et modes `Build`, `Plan` (lecture seule) et `Discussion` (sans outils) dans la barre de saisie.
- Réponses diffusées en direct mot par mot, erreurs de fournisseur explicites et appels d’outils jusqu’à huit tours. Les erreurs temporaires HTTP 429/500/502/503/504 et les erreurs réseau déclenchent jusqu’à dix nouvelles tentatives avec compte à rebours visible, délai exponentiel (de 2 à 300 secondes) et prise en compte de l’en-tête `Retry-After` ; les erreurs permanentes ne sont pas répétées. Les métadonnées de fournisseur renvoyées avec les appels d’outils, dont les signatures de pensée Gemini, sont conservées et retransmises pour que les tours d’outils restent valides.
- Arrêt d’une génération depuis le bouton carré ou avec `Échap` ; clic gauche ou droit sur un message utilisateur pour le modifier et le renvoyer, le copier ou supprimer ce message et la suite de l’historique.
- Contexte de projet visible dans le chat : arborescence limitée à 2 000 fichiers, instructions `AGENTS.md` / Copilot et manifestes racine usuels.
- Lecture de fichiers et exploration du projet ; les chemins restent limités au dossier de travail, et les dossiers d’identifiants et fichiers de secrets sont exclus.
- Écriture de fichier et commandes shell après confirmation ponctuelle dans LUCY, avec option d’autorisation pour toute la session. Les commandes sont limitées à 60 secondes et leur sortie à 20 000 caractères.
- Les appels d’outils, leurs arguments, leur sortie et le texte du modèle sont affichés dans l’ordre de la conversation, y compris pendant l’exécution. LUCY demande au modèle des justifications concises et vérifiables ; les chaînes de pensée internes privées ne sont pas exposées.
- Le chat conserve le défilement en bas uniquement si l’utilisateur s’y trouvait déjà ; l’explorateur de fichiers se rafraîchit automatiquement après les actions d’outil.
- Explorateur de fichiers, aperçu de fichiers et commandes locales `/help`, `/clear` et `/terminal`.

LUCY est une application autonome, mais ne recrée pas toutes les fonctionnalités d’OpenCode. Les connexions MCP directes et les fournisseurs propriétaires nécessitant leur moteur natif ne sont pas encore disponibles.
