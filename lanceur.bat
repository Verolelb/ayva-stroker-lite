@echo off
:: Se place dans le dossier où se trouve ce fichier .bat
cd /d "%~dp0"

echo Lancement de Ayva Stroker Lite...
echo.

:: Vérifie si les dépendances sont installées (si le dossier node_modules n'existe pas)
if not exist "node_modules" (
    echo Premiere execution detectee. Installation des dependances en cours...
    call npm install
)

:: Lance l'application
call npm run dev

:: Garde la fenêtre ouverte en cas d'erreur
pause