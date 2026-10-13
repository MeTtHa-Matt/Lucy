# LUCY // Neural Interface

LUCY est une application de bureau locale pour discuter avec des modèles d’IA et travailler dans un projet. Elle fonctionne sous Linux, notamment avec Hyprland, ainsi que sous Windows et macOS. L’interface s’adapte aux fenêtres étroites ; dans une session Hyprland, elle masque sa barre de titre personnalisée pour laisser la gestion des fenêtres au compositeur.

## Installation

L’installateur interactif vérifie les dépendances et propose leur installation avant de compiler LUCY. Il installe également le CLI OpenCode avec npm s’il manque, après confirmation. Sous Linux ou macOS, lance :

```sh
bash scripts/install.sh
```

Sous Windows, lance `scripts/install.bat` depuis l’Explorateur ou PowerShell. L’installateur utilise `winget` après confirmation pour les outils manquants, compile puis lance un véritable installateur NSIS par utilisateur. Celui-ci crée les raccourcis dans le menu Démarrer et sur le Bureau et ajoute une entrée de désinstallation Windows. Sur Linux, il détecte la distribution, le gestionnaire de paquets et l’environnement de bureau, puis installe le binaire, le lanceur `lucy.desktop` dans le menu des applications et son icône. Sur Linux et macOS, le CLI OpenCode est installé avec le préfixe `~/.local` et `~/.local/bin` est ajouté au PATH des nouveaux terminaux ; sous Windows, son dossier npm global est ajouté au PATH utilisateur. LUCY recherche également OpenCode dans ces emplacements lorsqu’elle le lance. Les installateurs compilent dans un cache Cargo dédié au compte utilisateur, séparé de `src-tauri/target`, pour éviter les erreurs de cache après déplacement ou copie du projet.

Après la compilation, l’installateur demande le prénom ou surnom à utiliser dans les conversations. Il est conservé localement et n’est pas modifiable depuis l’application après l’installation. Si le projet est déjà compilé manuellement, les prérequis et commandes d’installation ci-dessous restent disponibles.

Relancer l’installateur depuis le projet recompilé met à jour LUCY à son emplacement existant et rafraîchit son lanceur ; les sessions, fournisseurs et préférences locales sont conservés. Sous Windows, l’application doit être fermée pour remplacer l’exécutable.

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

Au premier lancement, LUCY importe automatiquement les comptes OpenCode déjà présents lorsque son stockage local ne contient encore aucun fournisseur. Les comptes OpenCode sont aussi resynchronisés aux lancements suivants, même si d’autres fournisseurs sont déjà configurés, afin d’ajouter les nouvelles connexions. Les identifiants Google, Groq et les connexions OAuth prises en charge sont importés. Les modèles gratuits d’OpenCode Zen sont listés sans clé ; leurs requêtes passent par `opencode run` dans l’installation locale d’OpenCode. LUCY lance l’agent `build` en mode Build et `plan` en mode Plan ou Discussion. Les outils natifs et demandes d’autorisation de ces agents suivent la configuration de permissions OpenCode ; LUCY ne force pas l’approbation automatique. Les connexions OpenCode Zen payantes avec clé API sont importées séparément. En cas d’échec du catalogue, l’interface affiche une erreur et permet de réessayer. Le modèle choisi est conservé localement. Sous Linux, l’installateur ajoute `~/.local/bin` au `PATH` des nouveaux terminaux et installe un raccourci dans le menu des applications.

## Fournisseurs et modèles

Dans **Fournisseurs & modèles**, tu peux importer les identifiants OpenCode compatibles via `opencode auth export` ou, si cette commande n’existe pas dans ta version, depuis son fichier local `auth.json`. Tu peux aussi enregistrer une URL d’API compatible OpenAI et une clé. Les modèles gratuits Zen sont découverts automatiquement et ne nécessitent pas de clé API dans LUCY ; le CLI OpenCode installé localement doit aussi être connecté. Les tâches OpenCode n’ont pas de limite de durée fixe ; tu peux arrêter une génération à tout moment avec le bouton carré ou `Échap`. Pour Ollama, utilise généralement `http://127.0.0.1:11434/v1` et laisse la clé vide. Actualise ensuite la liste des modèles et sélectionne le modèle souhaité.

Les identifiants LUCY sont stockés dans son dossier de configuration local avec des permissions Unix `0600`. Les requêtes partent directement de LUCY vers l’URL configurée. Les comptes propriétaires qui ne fournissent pas une API compatible ne peuvent pas être importés ; le renouvellement automatique du jeton OAuth GitHub Copilot n’est pas pris en charge.

## Capacités disponibles

- Conversations locales, sélection de fournisseur/modèle et conservation de l’historique.
- Condensation automatique du contexte de session : quand l’historique approche une limite estimée, LUCY demande au modèle connecté un résumé persistant et garde les échanges récents intacts. En cas de refus explicite pour dépassement de contexte, elle condense davantage puis réessaie automatiquement. L’historique complet reste visible et sauvegardé localement ; seul le contexte envoyé au modèle est résumé.
- Indicateur circulaire d’utilisation du contexte près du bouton d’envoi : il affiche une estimation du contexte transmis par rapport à la fenêtre du modèle, et révèle le pourcentage et le nombre de tokens au clic. La taille de fenêtre est estimée à partir de l’identifiant du modèle et peut varier selon le fournisseur.
- Au lancement, LUCY ouvre le dossier de travail local par défaut et crée une nouvelle session. Le dossier de projet reste modifiable depuis la barre latérale.
- Sélecteur de modèle et modes `Build`, `Plan` (lecture seule) et `Discussion` dans la barre de saisie. L’accès aux outils dépend du mode et du fournisseur sélectionné.
- Réponses diffusées en direct, erreurs de fournisseur explicites et appels d’outils jusqu’à huit tours pour les fournisseurs compatibles. Quand le modèle atteint sa limite de sortie en cours de réponse, LUCY lui demande automatiquement de continuer jusqu’à deux fois ; si la limite est toujours atteinte, l’interface signale l’interruption au lieu de présenter la réponse comme terminée. Les erreurs temporaires HTTP 429/500/502/503/504 et les erreurs réseau déclenchent jusqu’à dix nouvelles tentatives avec compte à rebours visible, délai exponentiel (de 2 à 300 secondes) et prise en compte de l’en-tête `Retry-After` ; les erreurs permanentes ne sont pas répétées. Les métadonnées de fournisseur renvoyées avec les appels d’outils, dont les signatures de pensée Gemini, sont conservées et retransmises pour que les tours d’outils restent valides.
- Lucy peut suspendre une génération pour demander une précision essentielle, avec des réponses suggérées ou libres ; cette possibilité est disponible dans les modes Build, Plan et Discussion. Les résumés d’approche et les actions d’outils sont affichés dans le fil lorsqu’ils sont disponibles. Lucy expose des résumés destinés à l’utilisateur, jamais une chaîne de pensée privée ; avec OpenCode Zen, elle pose la question dans la conversation et attend le prochain message.
- Arrêt d’une génération depuis le bouton carré ou avec `Échap` ; clic gauche ou droit sur un message utilisateur pour le modifier et le renvoyer, le copier ou supprimer ce message et la suite de l’historique.
- Contexte de projet visible dans le chat : aperçu borné à 80 chemins et 3 000 caractères d’instructions `AGENTS.md` / Copilot ; les manifestes et autres fichiers sont lus à la demande.
- Gestion des skills au format Claude Code dans `.claude/skills/<nom>/SKILL.md` : création depuis l’interface, import d’un dossier de skill avec ses ressources et suppression. Seuls les noms/descriptions des 12 premiers skills sont inclus au départ ; les instructions complètes d’un skill pertinent sont lues à la demande dans tous les modes et ne sont pas conservées dans l’historique envoyé aux requêtes suivantes. En mode Discussion, ce chargement ciblé est le seul outil autorisé.
- Persona LUCY cohérente, concise et familière, indépendante du fournisseur et du modèle sélectionné. Le prénom renseigné à l’installation est inclus dans les instructions système et n’est pas modifiable depuis l’interface.
- Lecture de fichiers et exploration du projet ; les chemins restent limités au dossier de travail, et les dossiers d’identifiants et fichiers de secrets sont exclus.
- Pour les fournisseurs gérés directement par LUCY, l’écriture de fichiers et les commandes shell demandent une confirmation ponctuelle, avec option d’autorisation pour toute la session. Les commandes sont limitées à 60 secondes et leur sortie à 20 000 caractères. Les outils natifs d’OpenCode Zen utilisent les permissions configurées dans OpenCode.
- Les appels d’outils, leurs arguments, leurs résultats et le texte du modèle sont affichés dans l’ordre de la conversation, y compris pendant l’exécution, et restent visibles dans l’historique. L’explorateur de fichiers se rafraîchit après les actions d’outil.
- Le chat conserve le défilement en bas uniquement si l’utilisateur s’y trouvait déjà.
- Explorateur de fichiers, aperçu de fichiers et commandes locales `/help`, `/clear` (effacer l’affichage sans supprimer l’historique), `/skill` ou `/skills` (gestion des skills Claude Code du projet) et `/terminal`.

LUCY adapte son interface aux différentes tailles de fenêtre. Dans les sessions Hyprland, elle masque sa barre de titre intégrée et laisse le compositeur gérer les fenêtres. LUCY ne recrée pas toutes les fonctionnalités d’OpenCode : les connexions MCP directes et les fournisseurs propriétaires nécessitant leur moteur natif ne sont pas encore disponibles.
