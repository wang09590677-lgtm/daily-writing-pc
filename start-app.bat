@echo off
cd /d "%~dp0"
title AI ��ͯÿ��д��ѵ�� - ��и���

rem ============================================================
rem   һ��������˫�����ļ���Ӧ�á�
rem
rem   �����������ؼ����£�
rem     1) ����ͷȨ���Զ����������ٵ����Ƿ�������������ͷ��
rem     2) �Զ����� Astra Pro ����Žӷ�����������������
rem
rem   ����˵����
rem     ҳ���� file:// �򿪣��� Chrome �ﱾ�����ڡ���͸����Դ����
rem     ����ͷ��Ȩ�޷�����ס������ÿ�ζ������µ������漸�������������
rem       --allow-file-access-from-files    �� file:// ��ɿ�ʶ����Դ
rem       --use-fake-ui-for-media-stream    Ȩ��ѯ�ʿ��Զ��㡸������
rem       --user-data-dir=����Ŀ¼          ��һ��ר�����õ���������ʹ��
rem                                        ԭ���� Chrome �������У�����Ҳ
rem                                        һ����Ч������ᱻ���н����̵���
rem       --autoplay-policy                 �õδ��������������ȵ�һ��ҳ��
rem
rem   ע�⣺���ļ������� GBK(ANSI) ���룬�Ҳ��ܼ� chcp 65001��
rem         ���� cmd �������ҳ�л�������ע�ʹ��г��������������
rem         ��Ҫ���İ�ʱ��� build/gen-start-bat.py ���������ɡ�
rem ============================================================

rem ---------- ƴ�� index.html �� file:// ��ַ ----------
rem �������滻��б�ܣ�����д %CD:\=/% �ڲ��� cmd �汾�ϲ���Ч���������ȡ�
set "APPDIR=%CD%"
set "APPDIR=%APPDIR:\=/%"
set "URL=file:///%APPDIR%/index.html"

rem ---------- ��һ������������� Chrome����� Edge ----------
set "BROWSER="
if exist "C:\Program Files\Google\Chrome\Application\chrome.exe" set "BROWSER=C:\Program Files\Google\Chrome\Application\chrome.exe"
if not defined BROWSER if exist "C:\Program Files (x86)\Google\Chrome\Application\chrome.exe" set "BROWSER=C:\Program Files (x86)\Google\Chrome\Application\chrome.exe"
if not defined BROWSER if exist "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" set "BROWSER=C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
if not defined BROWSER if exist "C:\Program Files\Microsoft\Edge\Application\msedge.exe" set "BROWSER=C:\Program Files\Microsoft\Edge\Application\msedge.exe"
if not defined BROWSER if exist "%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe" set "BROWSER=%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe"

if not defined BROWSER (
  echo [!] û���ҵ� Chrome �� Edge��
  echo     ���ֶ��� Chrome �򿪱�Ŀ¼�µ� index.html��
  echo.
  pause
  exit /b 1
)

rem ---------- ר�����õ�Ŀ¼ ----------
set "PROFILE=%LOCALAPPDATA%\WritingCoachChrome"
if not exist "%PROFILE%" mkdir "%PROFILE%" 2>nul

rem ---------- ��λ Python�����������ſ��⣡���·�˵����----------
rem ע�⣺cmd �����ſ��ǡ������Ƚ�������ִ�С������ڵ� %VAR% �ڽ����ʱ��չ����
rem    ��ʱ��ֵ�����ڿ��� set ���ڿ����� %VAR% ������������Զ�Ǿ�ֵ���գ���
rem    ԭ��� set PY д�� else ����������� "%PY%" �ж� -> ��ԶΪ��
rem    -> ��Զ�ߡ�û�ҵ� Python��-> ����Ŵ�δ���������ֻ���˻ش���ɫ����
rem    �޷����Ѷ�λ�߼��ᵽ���⣬����ֻ�����á��������衹��
set "PY="
if exist "%~dp0tools\orbbec\python\pythonw.exe" set "PY=%~dp0tools\orbbec\python\pythonw.exe"
if not defined PY if exist "%~dp0python\pythonw.exe" set "PY=%~dp0python\pythonw.exe"
if not defined PY for /f "delims=" %%I in ('where pythonw 2^>nul') do if not defined PY set "PY=%%I"
if not defined PY for /f "delims=" %%I in ('where python 2^>nul') do if not defined PY set "PY=%%I"

rem ---------- Astra ����Žӷ��񣨶˿� 8765��----------
netstat -ano | findstr ":8765" | findstr "LISTENING" >nul
if not errorlevel 1 (
  echo [OK] ����Žӷ����Ѿ������У�����������
) else (
  if defined PY (
    echo �������� Astra Pro ����Žӷ��񣨻���С��һ�����ڣ��������...
    start "Astra ����Ž�" /min "%PY%" "%~dp0tools\orbbec\openni-bridge.py" --res 640x480 --fps 15
  ) else (
    echo [!] û�ҵ� Python��������ȷ���
    echo     ��л��˻ش���ɫʶ�𣬹����Կ��ã�ֻ�Ǿ��ȵ�һЩ��
  )
)

echo.
echo ���ڴ�Ӧ�ã����Ժ�...
start "" "%BROWSER%" --user-data-dir="%PROFILE%" --allow-file-access-from-files --use-fake-ui-for-media-stream --autoplay-policy=no-user-gesture-required --no-first-run --no-default-browser-check --disable-search-engine-choice-screen "%URL%"

echo.
echo ============================================================
echo  ������������ͷȨ�޻��Զ������������ٵ㡸��������
echo  ������и�������Զ�������ʶ��У׼������������ʾվλ���ɡ�
echo ============================================================
echo.
echo ������ 6 ����Զ��رա�
ping -n 7 127.0.0.1 >nul
exit /b 0
