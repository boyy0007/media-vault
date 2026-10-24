; Media Vault's installer (Inno Setup 6). Built by scripts\make-installer.ps1, which stages a clean copy with
; make-package.ps1 -Folder and passes it in as StageDir, with AppVersion and OutDir - don't run it on its own.
;
; It puts that copy in C:\Media Vault (or a folder you pick) for just this Windows user - no admin rights, since
; Media Vault keeps its library next to itself and Program Files isn't writable - adds a Start menu entry, and then
; opens Media Vault's own setup (or, when updating, starts Media Vault). Updating over an install only replaces the
; program's files: the library (pb_data or the folder chosen in setup), mediavault.json, logs, hosted sites and
; projects aren't part of the install, so they're never touched. Uninstalling stops this copy's servers, removes the
; shortcuts that open it and the program's files, and leaves all of that data where it is.

#ifndef StageDir
  #error Build with scripts\make-installer.ps1
#endif

[Setup]
AppId={{6F1D5E4A-9B3C-4C8E-A2D7-4D9E0B7C1F35}
AppName=Media Vault
AppVersion={#AppVersion}
AppVerName=Media Vault {#AppVersion}
AppPublisher=Media Vault
DefaultDirName=C:\Media Vault
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
UsePreviousAppDir=yes
DirExistsWarning=no
OutputDir={#OutDir}
OutputBaseFilename=Media-Vault-Setup-{#AppVersion}
SetupIconFile={#StageDir}\mediavault.ico
WizardImageFile={#ArtDir}\wizard-large.bmp
WizardSmallImageFile={#ArtDir}\wizard-small.bmp
WizardImageStretch=yes
UninstallDisplayIcon={app}\mediavault.ico
UninstallDisplayName=Media Vault
; No license page: MIT doesn't need accepting (LICENSE is installed with the rest). Welcome, folder (Install), done.
DisableWelcomePage=no
DisableReadyPage=yes
WizardStyle=modern
Compression=lzma2/max
SolidCompression=yes
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0
; Files in use (pocketbase.exe while Media Vault runs) are found with Restart Manager; setup offers to close them.
; Every run writes %TEMP%\Setup Log {date} #{n}.txt, so a failed install can be looked into afterwards.
SetupLogging=yes
CloseApplications=yes
RestartApplications=no

[Messages]
WelcomeLabel2=This installs Media Vault, your own photo, GIF and video library, on this PC.%n%nAfterwards Media Vault's setup opens: it asks for your email and a password and gets everything else ready. Updating an existing Media Vault keeps your library, accounts and sites.
FinishedLabel=Media Vault is installed.%n%nA new install: Media Vault's setup opens next - enter your email and a password, press Next through the pages and Set up at the end. It takes a few minutes.%n%nAn update: your library, accounts and settings were kept.
FinishedLabelNoIcons=Media Vault is installed.
SelectDirDesc=Where should Media Vault be installed?
SelectDirLabel3=Media Vault keeps its library in this folder too (unless you choose another place in its setup), so pick a drive with room. Not a OneDrive or Dropbox folder - syncing a live database can corrupt it.

[Files]
Source: "{#StageDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{userprograms}\Media Vault"; Filename: "{app}\start.bat"; WorkingDir: "{app}"; IconFilename: "{app}\mediavault.ico"; Flags: runminimized; Comment: "Starts Media Vault and opens its window"
Name: "{userprograms}\Media Vault setup"; Filename: "{app}\setup.bat"; WorkingDir: "{app}"; IconFilename: "{app}\mediavault.ico"; Flags: runminimized; Comment: "Changes Media Vault's settings"

[Run]
Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File ""{app}\scripts\Setup.ps1"""; WorkingDir: "{app}"; Description: "Set up Media Vault now"; Flags: postinstall nowait runhidden skipifsilent; Check: IsNewInstall
Filename: "{app}\start.bat"; WorkingDir: "{app}"; Description: "Start Media Vault"; Flags: postinstall nowait runminimized skipifsilent; Check: not IsNewInstall

[Code]
// A new install: no settings and no library yet (an update keeps both).
function IsNewInstall: Boolean;
begin
  Result := not FileExists(ExpandConstant('{app}\mediavault.json')) and not FileExists(ExpandConstant('{app}\pb_data\data.db'));
end;

// Only this account (plus SYSTEM and Administrators) may use the folder. A new folder in C:\ lets every account on
// the PC change it (Authenticated Users: Modify, inherited), and they could then read the library or swap in code that
// runs as this user - or as admin, through allow-firewall.bat. Runs on updates too, so older installs get it. The
// grant comes first and inheritance only goes when it worked, so the folder can never end up locked to everyone.
procedure CurStepChanged(CurStep: TSetupStep);
var
  Code: Integer;
  Dir: String;
begin
  if CurStep <> ssPostInstall then exit;
  Dir := RemoveBackslashUnlessRoot(ExpandConstant('{app}'));
  if Length(Dir) <= 3 then exit; // (installed straight into a drive like D:\ - that isn't ours to lock)
  Dir := '"' + Dir + '"';
  if Exec(ExpandConstant('{sys}\icacls.exe'), Dir + ' /grant:r "' + GetEnv('USERDOMAIN') + '\' + GetUserNameString + ':(OI)(CI)F" *S-1-5-18:(OI)(CI)F *S-1-5-32-544:(OI)(CI)F',
    '', SW_HIDE, ewWaitUntilTerminated, Code) and (Code = 0) then
    Exec(ExpandConstant('{sys}\icacls.exe'), Dir + ' /inheritance:r', '', SW_HIDE, ewWaitUntilTerminated, Code);
end;

var
  FirewallLeft: Boolean;

// Before the files go: scripts\mv-uninstall.ps1 stops this copy's window and servers, removes the Startup and desktop
// shortcuts that open it, turns off its Tailscale addresses and removes its firewall rules (Windows asks for admin
// rights for that once; a silent uninstall doesn't ask). Exit code 2 = the firewall rules are still there.
procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  Code: Integer;
  Args: String;
begin
  if CurUninstallStep <> usUninstall then exit;
  Args := '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + ExpandConstant('{app}\scripts\mv-uninstall.ps1') + '"';
  if UninstallSilent then Args := Args + ' -Silent';
  if Exec(ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe'), Args, ExpandConstant('{app}'), SW_HIDE, ewWaitUntilTerminated, Code) then
    FirewallLeft := Code = 2;
end;

// What's left (the library, settings, sites, projects) is said, not deleted.
procedure DeinitializeUninstall;
var
  Msg: String;
begin
  Msg := '';
  if DirExists(ExpandConstant('{app}')) then
    Msg := 'Media Vault is removed. Your library, settings, hosted sites and projects were kept in' + #13#10 +
      ExpandConstant('{app}') + #13#10#13#10 + 'Delete that folder yourself if you don''t need them any more (back up the library first).';
  if FirewallLeft then
    Msg := Msg + #13#10#13#10 + 'Its firewall rules ("Media Vault (port)" and "Media Vault sites (port)") are still there, because Windows didn''t get admin rights to remove them. ' +
      'They only let your home network and Tailscale in. To remove them: Start > "Windows Defender Firewall with Advanced Security" > Inbound Rules, select them and press Delete.';
  // (Suppressible: a silent uninstall - /SUPPRESSMSGBOXES - doesn't stop to show it.)
  if Msg <> '' then SuppressibleMsgBox(Msg, mbInformation, MB_OK, IDOK);
end;
