# Seeded once by the Morse image when your home has none — afterwards this
# file is yours. Managed by you, never overwritten.
#
# umask 002 keeps the group-write the Morse server relies on: its agents run
# as `morse:morse`, and your SSH files must stay group-editable (and
# vice versa). Leave it unless you know why you are changing it.
umask 002

HISTFILE=~/.zsh_history
HISTSIZE=10000
SAVEHIST=10000
setopt append_history share_history hist_ignore_dups

autoload -Uz compinit promptinit
compinit
promptinit
prompt adam1

alias ll='ls -l --color=auto'
alias la='ls -A --color=auto'
